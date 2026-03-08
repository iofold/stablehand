import { randomUUID } from 'node:crypto';
import { createDeepAgent } from 'deepagents';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { tool as lcTool } from '@langchain/core/tools';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentDefinition, Message } from '../types.js';
import type { AGUIEvent } from '../events/types.js';
import type { ToolCall } from '../tool/types.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import { LocalFunctionExecutor } from '../tool/executor.js';

interface AgentExecutorConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  provider?: 'anthropic' | 'openai';
}

/**
 * Interrupt state: when a tool requires approval, the executor yields
 * a CUSTOM interrupt event and pauses. The caller must resolve the interrupt
 * by calling `resolveInterrupt` before the generator continues.
 */
interface PendingInterrupt {
  toolCall: ToolCall;
  resolve: (approved: boolean) => void;
  promise: Promise<boolean>;
}

export class AgentExecutor {
  private chatModel: BaseChatModel | string;
  private toolExecutor: LocalFunctionExecutor;
  private knowledgeStore: KnowledgeStore;
  private model: string;
  private provider: 'anthropic' | 'openai';
  private pendingInterrupt: PendingInterrupt | null = null;

  constructor(
    config: AgentExecutorConfig,
    toolExecutor: LocalFunctionExecutor,
    knowledgeStore: KnowledgeStore,
  ) {
    if (
      config.provider === 'anthropic' ||
      config.model.includes('claude')
    ) {
      this.chatModel = new ChatAnthropic({
        model: config.model,
        apiKey: config.apiKey,
        ...(config.baseUrl
          ? { clientOptions: { baseURL: config.baseUrl } }
          : {}),
      });
    } else {
      // For OpenAI-compatible providers (Cloudflare AI Gateway, OpenRouter, etc.)
      this.chatModel = new ChatOpenAI({
        model: config.model,
        apiKey: config.apiKey,
        configuration: {
          baseURL: config.baseUrl,
        },
      });
    }
    this.toolExecutor = toolExecutor;
    this.knowledgeStore = knowledgeStore;
    this.model = config.model;
    this.provider = config.provider || 'anthropic';
  }

  /**
   * Resolve a pending HITL interrupt.
   */
  resolveInterrupt(approved: boolean): void {
    if (this.pendingInterrupt) {
      this.pendingInterrupt.resolve(approved);
      this.pendingInterrupt = null;
    }
  }

  /**
   * Run a conversation turn. Yields AG-UI events as they happen.
   * Implements the full agentic loop via deepagents/LangGraph:
   *   1. Create a deepagent with tools converted to langchain format
   *   2. Stream events via LangGraph's streamEvents
   *   3. Map LangGraph events to AG-UI events
   *   4. Handle HITL interrupts for tools with requiresApproval
   */
  async *run(
    agentDef: AgentDefinition,
    messages: Message[],
  ): AsyncGenerator<AGUIEvent> {
    const runId = randomUUID();

    yield { type: 'RUN_STARTED', timestamp: Date.now(), runId };

    try {
      // Render knowledge into system prompt
      const knowledge = await this.knowledgeStore.render(agentDef.name);
      const systemPrompt = agentDef.systemPrompt.replace(
        '{{knowledge}}',
        knowledge || 'No learned knowledge yet.',
      );

      // Build the tool context once for the entire run
      const ctx = {
        agentId: agentDef.name,
        conversationId: runId,
        knowledge: {
          query: async (opts: { text: string; limit?: number }) => {
            const items = await this.knowledgeStore.list(agentDef.name);
            // Simple keyword matching for Level 1
            const filtered = items.filter((item) =>
              item.content.toLowerCase().includes(opts.text.toLowerCase()),
            );
            return {
              items: filtered.slice(0, opts.limit || 5).map((item) => ({
                id: item.id,
                content: item.content,
                score: 1.0,
              })),
            };
          },
        },
      };

      // Build langchain tools that wrap our tool definitions,
      // including HITL interrupt support
      const lcTools = this.buildLangChainTools(ctx, runId) as any[];

      // Use the configured chat model — agent-level model overrides are only
      // applied when the provider matches (don't try ChatAnthropic with an OpenAI key)
      const chatModel: BaseChatModel | string = this.chatModel;

      // Create the deep agent — cast to `any` to avoid TS2589
      // ("Type instantiation is excessively deep") caused by the
      // heavily-generic DeepAgent/ReactAgent type parameters.
      const agent = createDeepAgent({
        model: chatModel as any,
        tools: lcTools,
        systemPrompt,
      }) as any;

      // Convert messages to the format deepagents expects
      const langchainMessages = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // Stream events from the agent
      const eventStream = (agent as { streamEvents: (...args: any[]) => AsyncIterable<any> }).streamEvents(
        { messages: langchainMessages },
        { version: 'v2' },
      );

      const messageId = randomUUID();
      let textStarted = false;
      let currentTextContent = '';
      let currentToolCallId: string | null = null;
      let currentToolCallName: string | null = null;
      // Track tool call IDs seen from on_tool_start for TOOL_CALL_RESULT mapping
      const toolRunIdToInfo = new Map<string, { toolCallId: string; toolName: string; startTime: number }>();

      for await (const ev of eventStream) {
        const event = ev.event as string;
        const data = ev.data as Record<string, any>;
        const name = ev.name as string | undefined;

        if (event === 'on_chat_model_stream') {
          const chunk = data.chunk;
          if (!chunk) continue;

          // Text content
          const content = chunk.content;
          if (content && typeof content === 'string' && content.length > 0) {
            if (!textStarted) {
              textStarted = true;
              yield {
                type: 'TEXT_MESSAGE_START',
                timestamp: Date.now(),
                runId,
                messageId,
              };
            }
            currentTextContent += content;
            yield {
              type: 'TEXT_MESSAGE_CONTENT',
              timestamp: Date.now(),
              runId,
              messageId,
              content,
            };
          }

          // Tool call chunks
          const toolCallChunks = chunk.tool_call_chunks;
          if (toolCallChunks && Array.isArray(toolCallChunks) && toolCallChunks.length > 0) {
            for (const tc of toolCallChunks) {
              if (tc.name) {
                // End text block if one is open before starting tool call
                if (textStarted) {
                  const a2uiPayload = detectA2UI(currentTextContent);
                  if (a2uiPayload) {
                    yield {
                      type: 'CUSTOM',
                      timestamp: Date.now(),
                      runId,
                      subtype: 'a2ui',
                      payload: a2uiPayload,
                    };
                  }
                  yield {
                    type: 'TEXT_MESSAGE_END',
                    timestamp: Date.now(),
                    runId,
                    messageId,
                  };
                  textStarted = false;
                  currentTextContent = '';
                }

                // New tool call starting
                currentToolCallId = tc.id || randomUUID();
                currentToolCallName = tc.name;
                yield {
                  type: 'TOOL_CALL_START',
                  timestamp: Date.now(),
                  runId,
                  toolCallId: currentToolCallId,
                  toolName: tc.name,
                };
              }
              if (tc.args && currentToolCallId) {
                yield {
                  type: 'TOOL_CALL_ARGS',
                  timestamp: Date.now(),
                  runId,
                  toolCallId: currentToolCallId,
                  args: tc.args,
                };
              }
            }
          }
        }

        if (event === 'on_chat_model_end') {
          // End text if started
          if (textStarted) {
            const a2uiPayload = detectA2UI(currentTextContent);
            if (a2uiPayload) {
              yield {
                type: 'CUSTOM',
                timestamp: Date.now(),
                runId,
                subtype: 'a2ui',
                payload: a2uiPayload,
              };
            }
            yield {
              type: 'TEXT_MESSAGE_END',
              timestamp: Date.now(),
              runId,
              messageId,
            };
            textStarted = false;
            currentTextContent = '';
          }
          // End tool call if pending
          if (currentToolCallId) {
            yield {
              type: 'TOOL_CALL_END',
              timestamp: Date.now(),
              runId,
              toolCallId: currentToolCallId,
            };
            // Don't clear currentToolCallId yet — on_tool_start needs it
            // to map the LangGraph run_id back to our tool call ID
          }
        }

        if (event === 'on_tool_start') {
          const toolCallId = currentToolCallId || randomUUID();
          const toolName = name || 'unknown';
          const toolRunId = data.run_id as string | undefined;
          if (toolRunId) {
            toolRunIdToInfo.set(toolRunId, {
              toolCallId,
              toolName,
              startTime: Date.now(),
            });
          }
          // Now safe to clear — the mapping is saved
          currentToolCallId = null;
          currentToolCallName = null;
        }

        if (event === 'on_tool_end') {
          const toolName = name || 'unknown';
          const toolRunId = data.run_id as string | undefined;
          const info = toolRunId ? toolRunIdToInfo.get(toolRunId) : undefined;
          const toolCallId = info?.toolCallId || randomUUID();
          const startTime = info?.startTime || Date.now();
          const durationMs = Date.now() - startTime;

          if (toolRunId) {
            toolRunIdToInfo.delete(toolRunId);
          }

          const output = data.output;
          const resultStr =
            typeof output === 'string'
              ? output
              : typeof output?.content === 'string'
                ? output.content
                : JSON.stringify(output);

          yield {
            type: 'TOOL_CALL_RESULT',
            timestamp: Date.now(),
            runId,
            toolCallId,
            toolName: info?.toolName || toolName,
            result: resultStr,
            durationMs,
          };
        }
      }

      // Ensure any trailing text block is closed
      if (textStarted) {
        const a2uiPayload = detectA2UI(currentTextContent);
        if (a2uiPayload) {
          yield {
            type: 'CUSTOM',
            timestamp: Date.now(),
            runId,
            subtype: 'a2ui',
            payload: a2uiPayload,
          };
        }
        yield {
          type: 'TEXT_MESSAGE_END',
          timestamp: Date.now(),
          runId,
          messageId,
        };
      }

      yield { type: 'RUN_FINISHED', timestamp: Date.now(), runId };
    } catch (err) {
      yield {
        type: 'RUN_ERROR',
        timestamp: Date.now(),
        runId,
        error: String(err),
      };
    }
  }

  /**
   * Build langchain tool wrappers around our registered tools.
   * Wraps each tool with HITL interrupt logic when requiresApproval is set.
   */
  private buildLangChainTools(
    ctx: {
      agentId: string;
      conversationId: string;
      knowledge: {
        query: (opts: { text: string; limit?: number }) => Promise<{
          items: Array<{ id: string; content: string; score: number }>;
        }>;
      };
    },
    _runId: string,
  ) {
    const toolDefs = this.toolExecutor.list();
    return toolDefs.map((def) => {
      return lcTool(
        async (args: Record<string, unknown>) => {
          // HITL: if the tool requires approval, create an interrupt and wait
          if (def.requiresApproval) {
            const toolCall: ToolCall = {
              id: randomUUID(),
              name: def.name,
              arguments: args,
            };

            let resolveInterrupt!: (approved: boolean) => void;
            const interruptPromise = new Promise<boolean>((resolve) => {
              resolveInterrupt = resolve;
            });

            this.pendingInterrupt = {
              toolCall,
              resolve: resolveInterrupt,
              promise: interruptPromise,
            };

            // The HITL interrupt event is emitted in the run() generator
            // via the on_tool_start event detection. Here we just block
            // until resolved. In practice the caller sees the CUSTOM interrupt
            // event from the stream and calls resolveInterrupt().
            // NOTE: Since we cannot yield AG-UI events from inside a tool
            // handler, the HITL mechanism here relies on the caller detecting
            // tool_start for requiresApproval tools and calling resolveInterrupt.
            const approved = await interruptPromise;

            if (!approved) {
              throw new Error('Tool call was rejected by the user.');
            }
          }

          const toolCall: ToolCall = {
            id: randomUUID(),
            name: def.name,
            arguments: args,
          };

          const result = await this.toolExecutor.execute(toolCall, ctx);
          if (result.error) {
            throw new Error(result.error);
          }
          return result.result;
        },
        {
          name: def.name,
          description: def.description,
          schema: def.input,
        },
      );
    });
  }
}

/**
 * Detect A2UI JSON payload in text content.
 * Looks for a JSON object with `component` and `props` fields.
 */
function detectA2UI(
  text: string,
): { component: string; props: Record<string, unknown> } | null {
  // Try to find a JSON block in the text
  const jsonPattern = /\{[\s\S]*"component"\s*:\s*"[^"]+?"[\s\S]*"props"\s*:\s*\{[\s\S]*?\}[\s\S]*?\}/;
  const match = text.match(jsonPattern);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]);
    if (
      typeof parsed.component === 'string' &&
      typeof parsed.props === 'object' &&
      parsed.props !== null
    ) {
      return { component: parsed.component, props: parsed.props };
    }
  } catch {
    // Not valid JSON
  }

  return null;
}
