import { randomUUID } from 'node:crypto';
import { createDeepAgent } from 'deepagents';
import { tool as lcTool } from '@langchain/core/tools';
import type { BaseLanguageModel } from '@langchain/core/language_models/base';
import type { StreamEvent } from '@langchain/core/types/stream';
import type { AgentHarness, AgentEvent, HarnessRunConfig } from './types.js';
import type { ToolCall } from '../tool/types.js';
import type { LLMProvider } from '../llm/types.js';
import { LocalFunctionExecutor } from '../tool/executor.js';
import type { KnowledgeStore } from '../knowledge/types.js';
import type { InterruptManager } from '../orchestrator/interrupt.js';
import type { EnvironmentFactory, ExecutionEnvironment } from '../workspace/types.js';
import { normalizeStreamTextDeltas } from '../agent/executor.js';

/**
 * Minimal interface for a deep agent that supports streamEvents.
 * We define this locally to avoid TS2589 ("Type instantiation is
 * excessively deep") caused by the heavily-generic DeepAgent type.
 */
interface StreamableAgent {
  streamEvents(
    input: { messages: Array<{ role: 'user' | 'assistant'; content: string }> },
    options: { version: 'v1' | 'v2' },
  ): AsyncIterable<StreamEvent>;
}

/**
 * LangGraph/deepagents harness adapter.
 *
 * Extracts the core agent execution logic that was previously embedded in
 * AgentExecutor.run() and yields normalized AgentEvent instances.
 */
export class LangGraphHarness implements AgentHarness {
  readonly name = 'langgraph';

  private chatModel: BaseLanguageModel;
  private toolExecutor: LocalFunctionExecutor;
  private knowledgeStore: KnowledgeStore;
  private interruptManager: InterruptManager | null;
  private envFactory: EnvironmentFactory | null;

  constructor(
    llmProvider: LLMProvider,
    toolExecutor: LocalFunctionExecutor,
    knowledgeStore: KnowledgeStore,
    interruptManager?: InterruptManager,
    envFactory?: EnvironmentFactory,
  ) {
    if (!llmProvider.getChatModel) {
      throw new Error(
        'LangGraphHarness requires an LLMProvider that implements getChatModel()',
      );
    }
    this.chatModel = llmProvider.getChatModel() as BaseLanguageModel;
    this.toolExecutor = toolExecutor;
    this.knowledgeStore = knowledgeStore;
    this.interruptManager = interruptManager ?? null;
    this.envFactory = envFactory ?? null;
  }

  /** Get the configured EnvironmentFactory (if any). */
  getEnvironmentFactory(): EnvironmentFactory | null {
    return this.envFactory;
  }

  async *run(config: HarnessRunConfig): AsyncGenerator<AgentEvent> {
    const { agentId, runId, messages, tools, workspaceDir } = config;
    const knowledgeKey = agentId;

    try {
      // Render knowledge into system prompt
      const knowledge = await this.knowledgeStore.render(knowledgeKey);
      const systemPrompt = config.systemPrompt.replace(
        '{{knowledge}}',
        knowledge || 'No learned knowledge yet.',
      );

      // Create session environment if factory is available
      let env: ExecutionEnvironment | undefined;
      if (this.envFactory && workspaceDir) {
        const { join } = await import('node:path');
        const sessionsDir = join(workspaceDir, '..', '..', 'sessions');
        env = this.envFactory.create(workspaceDir, runId, sessionsDir);
        await env.setup();
      }

      // Build the tool context once for the entire run
      const ctx = {
        agentId: knowledgeKey,
        conversationId: runId,
        workspaceDir: env?.workspacePath ?? workspaceDir ?? process.cwd(),
        env,
        eventBus: config.eventBus ?? undefined,
        knowledge: {
          query: async (opts: { text: string; limit?: number }) => {
            const items = await this.knowledgeStore.list(knowledgeKey);
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

      // Build langchain tools that wrap our tool definitions
      const lcTools = this.buildLangChainTools(ctx, runId, tools);

      // Create the deep agent
      const agent = createDeepAgent({
        model: this.chatModel,
        tools: lcTools,
        systemPrompt,
      }) as unknown as StreamableAgent;

      // Convert messages to the format deepagents expects
      const langchainMessages = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // Stream events from the agent
      const eventStream = agent.streamEvents(
        { messages: langchainMessages },
        { version: 'v2' },
      );

      let currentToolCallId: string | null = null;
      let currentToolCallName: string | null = null;
      const toolRunIdToInfo = new Map<string, { toolCallId: string; toolName: string; startTime: number }>();

      for await (const ev of eventStream) {
        const event = ev.event;
        const data = ev.data;
        const evName = ev.name;

        if (event === 'on_chat_model_stream') {
          const chunk = data.chunk;
          if (!chunk) continue;

          // Yield text deltas
          for (const textDelta of normalizeStreamTextDeltas(chunk.content)) {
            yield { type: 'text_delta', content: textDelta };
          }

          // Tool call chunks
          const toolCallChunks = chunk.tool_call_chunks;
          if (toolCallChunks && Array.isArray(toolCallChunks) && toolCallChunks.length > 0) {
            for (const tc of toolCallChunks) {
              if (tc.name) {
                // New tool call starting
                const tcId = tc.id || randomUUID();
                currentToolCallId = tcId;
                currentToolCallName = tc.name;
                yield {
                  type: 'tool_call_start',
                  id: tcId,
                  name: tc.name,
                  args: tc.args ?? '',
                };
              }
            }
          }
        }

        if (event === 'on_chat_model_end') {
          // Clear current tool call tracking after chat model ends
          if (currentToolCallId) {
            // Don't clear currentToolCallId yet — on_tool_start needs it
          }
        }

        if (event === 'on_tool_start') {
          const toolCallId = currentToolCallId || randomUUID();
          const toolName = evName || 'unknown';
          const toolRunId: string | undefined = ev.run_id;
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
          const toolName = evName || 'unknown';
          const toolRunId: string | undefined = ev.run_id;
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
            type: 'tool_call_end',
            id: toolCallId,
            result: resultStr,
            durationMs,
          };
        }
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: String(err) };
    }
  }

  /**
   * Build langchain tool wrappers around the provided tool definitions.
   * Wraps each tool with HITL interrupt logic when requiresApproval is set.
   */
  private buildLangChainTools(
    ctx: {
      agentId: string;
      conversationId: string;
      workspaceDir: string;
      eventBus?: import('../events/bus.js').TypedEventBus;
      knowledge: {
        query: (opts: { text: string; limit?: number }) => Promise<{
          items: Array<{ id: string; content: string; score: number }>;
        }>;
      };
    },
    runId: string,
    toolDefs: import('../tool/types.js').ToolDefinition[],
  ) {
    return toolDefs.map((def) => {
      return lcTool(
        async (args: Record<string, unknown>) => {
          // HITL: if the tool requires approval, delegate to InterruptManager
          if (def.requiresApproval) {
            if (this.interruptManager) {
              const toolCallId = randomUUID();
              const resolution = await this.interruptManager.waitForApproval(
                runId,
                ctx.agentId,
                toolCallId,
                def.name,
                args as Record<string, unknown>,
              );

              if (resolution.action !== 'approve') {
                const reason = resolution.action === 'timeout'
                  ? 'Tool call approval timed out.'
                  : 'Tool call was rejected by the user.';
                throw new Error(reason);
              }
            }
            // If no interruptManager, auto-approve for backward compatibility
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
