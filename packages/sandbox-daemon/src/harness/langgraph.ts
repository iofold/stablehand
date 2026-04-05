import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool as lcTool } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseLanguageModel } from '@langchain/core/language_models/base';
import type { StreamEvent } from '@langchain/core/types/stream';
import type {
  AgentHarness,
  AgentEvent,
  HarnessSession,
  HarnessSessionConfig,
  HarnessRestorePoint,
  HarnessTurnInput,
  HarnessTurnContext,
  HarnessExportedState,
  ApprovalRequest,
} from './types.js';
import type { Message } from '../types.js';
import { createStubKnowledgeContext, resolveSecretRef, normalizeStreamTextDeltas } from './shared.js';

export const LangGraphConfigSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'google']).default('openai'),
  model: z.string().min(1),
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().refine((value) => URL.canParse(value)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  reasoning: z.enum(['off', 'low', 'medium', 'high']).optional(),
  setup: z.object({
    symlinks: z.array(z.object({
      src: z.string(),
      dest: z.string(),
    })).optional(),
  }).optional(),
  subagents: z.array(z.object({
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string(),
    provider: z.enum(['openai', 'anthropic', 'google']).optional(),
    model: z.string().min(1).optional(),
    apiKeyRef: z.string().optional(),
    tools: z.array(z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  })).optional(),
});

export type LangGraphConfig = z.infer<typeof LangGraphConfigSchema>;

/**
 * Minimal interface for a deep agent that supports streamEvents.
 * We define this locally to avoid TS2589 ("Type instantiation is
 * excessively deep") caused by the heavily-generic DeepAgent type.
 */
interface StreamableAgent {
  streamEvents(
    input: {
      messages: Array<{
        role: 'user' | 'assistant' | 'tool' | 'system';
        content: string;
        tool_call_id?: string;
      }>;
    },
    options: { version: 'v1' | 'v2' },
  ): AsyncIterable<StreamEvent>;
}

/**
 * LangGraph/deepagents harness adapter.
 *
 * Implements the session-factory AgentHarness interface. LangGraph is stateless
 * (creates a fresh deepagents/LangChain agent per turn). The session adapter
 * keeps an internal transcript array and passes the FULL history to the SDK
 * on each turn.
 */
export class LangGraphHarness implements AgentHarness {
  readonly name = 'langgraph';
  readonly configSchema = LangGraphConfigSchema;

  async openSession(config: HarnessSessionConfig, restore?: HarnessRestorePoint): Promise<HarnessSession> {
    const session = new LangGraphSession(config);
    if (restore) {
      const transcriptFromState = restore.payload['transcript'];
      if (Array.isArray(transcriptFromState) && transcriptFromState.length > 0) {
        session.restoreTranscript(transcriptFromState as Message[]);
      } else if (restore.messages.length > 0) {
        session.restoreTranscript(restore.messages);
      }
    }
    return session;
  }
}

class LangGraphSession implements HarnessSession {
  private transcript: Message[] = [];
  private readonly harnessConfig: LangGraphConfig;

  constructor(private readonly config: HarnessSessionConfig) {
    this.harnessConfig = LangGraphConfigSchema.parse(
      JSON.parse(z.string().parse(config.harnessConfigJson)),
    );
  }

  restoreTranscript(messages: Message[]): void {
    this.transcript = [...messages];
  }

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent> {
    const { agentId, conversationId, workspaceDir, tools, systemPrompt } = this.config;

    try {
      this.transcript = [...input.messages];

      // Step 1: Resolve the chat model from config + secrets
      const chatModel = await this.buildModelFromConfig();

      // Step 2: Build tool execution context
      const ctx = {
        agentId,
        conversationId,
        instanceId: input.turnId,
        workspaceDir: workspaceDir ?? process.cwd(),
        knowledge: createStubKnowledgeContext(),
      };

      // Step 3: Determine effective approval callback (turn-level takes precedence)
      const onApprovalNeeded = context.onApprovalNeeded ?? this.config.onApprovalNeeded;

      // Step 4: Build langchain tools that wrap our tool definitions
      const lcTools = this.buildLangChainTools(ctx, input.turnId, tools, onApprovalNeeded);

      // Step 5: Create the deep agent with LocalShellBackend for full filesystem/shell capabilities
      const { createDeepAgent, LocalShellBackend } = await this.loadDeepAgentsModule();
      const backend = new LocalShellBackend({
        rootDir: workspaceDir ?? process.cwd(),
        inheritEnv: true,
      });

      const allBlocklisted = this.config.nativeTools?.flatMap((c) => c.blocklist ?? []) ?? [];
      const resolvedSubagents = await this.buildSubagentParams(this.harnessConfig.subagents, lcTools);

      const hasSystemMessage = this.transcript.some((message) => message.role === 'system');

      const deepAgentParams: Record<string, unknown> = {
        model: chatModel,
        tools: lcTools,
        backend,
      };
      if (!hasSystemMessage) deepAgentParams.systemPrompt = systemPrompt;
      if (resolvedSubagents) deepAgentParams.subagents = resolvedSubagents;
      const middlewares: Record<string, unknown>[] = [
        createToolErrorBoundaryMiddleware(),
      ];
      if (allBlocklisted.length > 0) {
        middlewares.push(this.createToolBlocklistMiddleware(allBlocklisted));
      }
      deepAgentParams.middleware = middlewares;

      const agent = createDeepAgent(deepAgentParams as Parameters<typeof createDeepAgent>[0]) as unknown as StreamableAgent;

      // Step 6: Convert full transcript to deepagents message format
      const langchainMessages = this.transcript
        .map((m) => ({
          role: m.role as 'user' | 'assistant' | 'tool' | 'system',
          content: m.content,
          ...(m.role === 'tool' && m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        }));

      // Step 7: Stream events from the agent, accumulating assistant text for transcript
      const eventStream = agent.streamEvents(
        { messages: langchainMessages },
        { version: 'v2' },
      );

      const pendingToolCalls: Array<{ id: string; name: string }> = [];
      const toolRunIdToInfo = new Map<string, { toolCallId: string; startTime: number }>();
      let assistantText = '';
      const accumulatedToolCalls: Array<
        NonNullable<Message['toolCalls']>[number] & { args: string; status: 'complete' | 'error' }
      > = [];

      for await (const ev of eventStream) {
        const event = ev.event;
        const data = ev.data;

        if (event === 'on_chat_model_stream') {
          const chunk = data.chunk;
          if (!chunk) continue;

          for (const textDelta of normalizeStreamTextDeltas(chunk.content)) {
            assistantText += textDelta;
            yield { type: 'text_delta', content: textDelta };
          }

          const toolCallChunks = chunk.tool_call_chunks;
          if (toolCallChunks && Array.isArray(toolCallChunks) && toolCallChunks.length > 0) {
            for (const tc of toolCallChunks) {
              if (tc.name) {
                pendingToolCalls.push({
                  id: tc.id || randomUUID(),
                  name: tc.name,
                });
              }
            }
          }
        }

        if (event === 'on_tool_start') {
          const evData = ev as Record<string, unknown>;
          const rawName = (data as Record<string, unknown>).name ?? evData.name;
          const toolNameFromEvent = typeof rawName === 'string' ? rawName : undefined;

          let matchIdx = toolNameFromEvent
            ? pendingToolCalls.findIndex((p) => p.name === toolNameFromEvent)
            : -1;
          if (matchIdx < 0 && pendingToolCalls.length > 0) {
            matchIdx = 0;
          }
          const matched = matchIdx >= 0 ? pendingToolCalls.splice(matchIdx, 1)[0] : undefined;

          const toolCallId = matched?.id || randomUUID();
          const toolName = matched?.name || toolNameFromEvent || 'unknown';
          const toolRunId: string | undefined = ev.run_id;

          const rawInput = data.input ?? (evData.input as unknown) ?? {};
          let fullArgs: unknown = rawInput;
          if (typeof fullArgs === 'object' && fullArgs !== null && 'input' in fullArgs) {
            fullArgs = (fullArgs as Record<string, unknown>).input;
          }
          if (typeof fullArgs === 'string') {
            try { fullArgs = JSON.parse(fullArgs); } catch { /* keep as string */ }
          }
          if (fullArgs == null) fullArgs = {};

          yield {
            type: 'tool_call_start',
            id: toolCallId,
            name: toolName,
            args: fullArgs,
          };

          accumulatedToolCalls.push({
            id: toolCallId,
            name: toolName,
            arguments: typeof fullArgs === 'object' && fullArgs !== null && !Array.isArray(fullArgs)
              ? Object.fromEntries(Object.entries(fullArgs as Record<string, unknown>))
              : {},
            args: typeof fullArgs === 'string' ? fullArgs : JSON.stringify(fullArgs ?? {}),
            status: 'complete',
          });

          if (toolRunId) {
            toolRunIdToInfo.set(toolRunId, {
              toolCallId,
              startTime: Date.now(),
            });
          }
        }

        if (event === 'on_tool_end') {
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

        if (event === 'on_tool_error') {
          const toolRunId: string | undefined = ev.run_id;
          const info = toolRunId ? toolRunIdToInfo.get(toolRunId) : undefined;
          const toolCallId = info?.toolCallId || randomUUID();
          const startTime = info?.startTime || Date.now();
          const durationMs = Date.now() - startTime;

          if (toolRunId) {
            toolRunIdToInfo.delete(toolRunId);
          }

          const rawErr: unknown = data.error;
          const errMsg = rawErr instanceof Error ? rawErr.message : String(rawErr ?? 'Unknown tool error');

          yield {
            type: 'tool_call_end',
            id: toolCallId,
            result: errMsg,
            error: errMsg,
            durationMs,
          };

          const errEntry = accumulatedToolCalls.find((tc) => tc.id === toolCallId);
          if (errEntry) errEntry.status = 'error';
        }
      }

      const committedToolCalls: Message['toolCalls'] | undefined =
        accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined;

      if (assistantText.length > 0 || accumulatedToolCalls.length > 0) {
        this.transcript.push({
          id: randomUUID(),
          agentId,
          role: 'assistant',
          content: assistantText,
          ...(committedToolCalls ? { toolCalls: committedToolCalls } : {}),
          createdAt: new Date(),
        });

        yield {
          type: 'message_committed' as const,
          role: 'assistant' as const,
          content: assistantText,
          ...(committedToolCalls ? { toolCalls: committedToolCalls } : {}),
          turnId: `turn-${randomUUID().slice(0, 8)}`,
          messageSeq: this.transcript.length - 1,
        };
      }

      yield { type: 'done' };
    } catch (err) {
      console.error('[langgraph] deliverTurn error:', err);
      yield { type: 'error', error: String(err) };
    }
  }

  async exportState(): Promise<HarnessExportedState> {
    return {
      stateVersion: '1',
      payload: { transcript: this.transcript },
    };
  }

  async close(): Promise<void> {
    // Stateless — deepagents creates a fresh agent per turn, nothing to tear down
  }

  private createToolBlocklistMiddleware(blocklist: string[]): Record<string, unknown> {
    const blocked: ReadonlySet<string> = new Set(blocklist);
    return {
      name: 'ctxmill-tool-blocklist',
      beforeToolCall: (call: { name: string }) => {
        if (blocked.has(call.name)) {
          return { blocked: true, reason: `Tool '${call.name}' is blocklisted by nativeTools config` };
        }
        return { blocked: false };
      },
    };
  }

  private async buildModelFromConfig(): Promise<BaseLanguageModel> {
    return this.buildModelForConfig(this.harnessConfig);
  }

  private async loadDeepAgentsModule(): Promise<typeof import('deepagents')> {
    return import('deepagents');
  }

  private async buildModelForConfig(config: {
    provider: 'openai' | 'anthropic' | 'google';
    model: string;
    apiKeyRef?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
    reasoning?: 'off' | 'low' | 'medium' | 'high';
  }): Promise<BaseLanguageModel> {
    const { secrets } = this.config;
    const { provider, model, apiKeyRef, baseUrl, temperature, maxTokens, reasoning } = config;
    const resolvedApiKey = apiKeyRef
      ? resolveSecretRef(apiKeyRef, secrets)
      : provider === 'anthropic'
        ? (secrets.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY)
        : provider === 'google'
          ? (secrets.GOOGLE_API_KEY ?? process.env.GOOGLE_API_KEY)
          : (secrets.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY);

    if (provider === 'anthropic') {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      return new ChatAnthropic({
        anthropicApiKey: resolvedApiKey || undefined,
        anthropicApiUrl: baseUrl || undefined,
        model,
        modelName: model,
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxTokens } : {}),
      }) as unknown as BaseLanguageModel;
    } else if (provider === 'google') {
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
      return new ChatGoogleGenerativeAI({
        apiKey: resolvedApiKey || undefined,
        model,
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
      }) as unknown as BaseLanguageModel;
    } else {
      const { ChatOpenAI } = await import('@langchain/openai');
      return new ChatOpenAI({
        apiKey: resolvedApiKey || undefined,
        configuration: baseUrl ? { baseURL: baseUrl } : undefined,
        modelName: model,
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxTokens } : {}),
        ...(reasoning && reasoning !== 'off' ? { reasoning_effort: reasoning } : {}),
      }) as unknown as BaseLanguageModel;
    }
  }

  private async buildSubagentParams(
    subagentConfigs: z.infer<typeof LangGraphConfigSchema>['subagents'],
    parentTools?: unknown[],
  ): Promise<Record<string, unknown>[] | undefined> {
    if (!subagentConfigs?.length) return undefined;

    // Build a lookup from tool name → tool object for subagent tool filtering
    const toolsByName = new Map<string, unknown>();
    if (parentTools) {
      for (const tool of parentTools) {
        const name = (tool as Record<string, unknown>)?.name;
        if (typeof name === 'string') toolsByName.set(name, tool);
      }
    }

    return Promise.all(
      subagentConfigs.map(async (config) => {
        const result: Record<string, unknown> = {
          name: config.name,
          description: config.description,
          systemPrompt: config.systemPrompt,
        };

        if (config.provider || config.model) {
          result.model = await this.buildModelForConfig({
            provider: config.provider ?? this.harnessConfig.provider,
            model: config.model ?? this.harnessConfig.model,
            apiKeyRef: config.apiKeyRef,
            baseUrl: this.harnessConfig.baseUrl,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
          });
        }

        // Resolve tool name strings to actual tool objects from the parent tool set
        if (config.tools && parentTools) {
          const resolved = config.tools
            .map((name: string) => toolsByName.get(name))
            .filter((t): t is NonNullable<typeof t> => t != null);
          if (resolved.length > 0) result.tools = resolved;
        }

        return result;
      }),
    );
  }

  /* -------------------------------------------------------------------------- */
  /*  Build langchain tool wrappers                                             */
  /* -------------------------------------------------------------------------- */

  /**
   * Build langchain tool wrappers around the provided tool definitions.
   * Wraps each tool with HITL interrupt logic when requiresApproval is set,
   * using the onApprovalNeeded callback.
   */
  private buildLangChainTools(
    ctx: {
      agentId: string;
      conversationId: string;
      instanceId?: string;
      workspaceDir: string;
      knowledge: {
        query: (opts: { text: string; limit?: number }) => Promise<{
          items: Array<{ id: string; content: string; score: number }>;
        }>;
      };
    },
    turnId: string,
    toolDefs: import('../tool/types.js').ToolDefinition[],
    onApprovalNeeded: import('./types.js').ApprovalCallback | undefined,
  ) {
    return toolDefs.map((def) => {
      return lcTool(
        async (args: Record<string, unknown>) => {
          // HITL: if the tool requires approval, delegate to onApprovalNeeded callback
          if (def.requiresApproval) {
            if (onApprovalNeeded) {
              const req: ApprovalRequest = {
                id: randomUUID(),
                runId: turnId,
                toolName: def.name,
                args: args as Record<string, unknown>,
              };
              const res = await onApprovalNeeded(req);
              if (res.action !== 'approve') {
                return 'Tool call was rejected by the user.';
              }
            }
          }

          // Execute the tool via its handler directly (no LocalFunctionExecutor needed)
          try {
            const result = await def.handler(args, ctx);
            return result;
          } catch (handlerErr) {
            // Return handler errors as tool results so the LLM can see and recover,
            // rather than letting them propagate and crash the entire turn.
            const msg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
            return `Tool "${def.name}" execution failed: ${msg}`;
          }
        },
        {
          name: def.name,
          description: def.description,
          schema: def.input as import('zod').ZodType,
        },
      );
    });
  }
}

const GRAPH_INTERRUPT_NAMES = new Set(['GraphInterrupt', 'NodeInterrupt']);

/**
 * Middleware that catches tool execution errors and returns them as ToolMessage
 * results instead of letting them propagate and kill the session.
 *
 * Why this exists: langchain's ToolNode re-throws middleware-wrapped tool errors
 * unless handleToolErrors === true (literal boolean). Neither createAgent nor
 * createDeepAgent expose that flag. This middleware catches errors at the
 * wrapToolCall layer — before ToolNode's re-throw logic sees them.
 *
 * GraphInterrupt/NodeInterrupt are preserved (re-thrown) since they're
 * intentional control flow for human-in-the-loop, not recoverable errors.
 */
function createToolErrorBoundaryMiddleware(): Record<string, unknown> {
  return {
    name: 'CtxmillToolErrorBoundary',
    wrapToolCall: async (
      request: { toolCall: { id?: string; name: string }; [k: string]: unknown },
      handler: (req: unknown) => Promise<unknown>,
    ) => {
      try {
        return await handler(request);
      } catch (err: unknown) {
        if (err != null && typeof err === 'object' && 'name' in err &&
            GRAPH_INTERRUPT_NAMES.has((err as { name: string }).name)) {
          throw err;
        }

        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sandbox] tool error boundary caught: ${request.toolCall.name} — ${msg}`);
        return new ToolMessage({
          content: `Tool "${request.toolCall.name}" failed: ${msg}`,
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
        });
      }
    },
  };
}
