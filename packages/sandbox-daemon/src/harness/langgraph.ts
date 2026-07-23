import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
  ResolvedSecrets,
  TokenUsage,
} from './types.js';
import type { Message } from '../types.js';
import { normalizeStreamTextDeltas } from './shared.js';
import { LangGraphConfigSchema, type LangGraphConfig } from './schemas.js';
import { makeIterableAbortable } from './abort-iterator.js';
import {
  TurnAccumulator,
  errorMessage,
  finalizeTurn,
  linkTurnAbort,
  normalizeTokenUsage,
  parseHarnessConfig,
  requestToolApproval,
  withTurnTracing,
} from './kit/index.js';
import { isNativeToolAllowed } from './native-tool-policy.js';
import {
  createGatewayCorrelationHeaders,
  resolveHarnessModelConnection,
} from './model-gateway.js';
import { TURN_ONLY_ENFORCEMENT_CAPABILITIES } from './enforcement/types.js';

/**
 * Minimal interface for a deep agent that supports streamEvents.
 * We define this locally to avoid TS2589 ("Type instantiation is
 * excessively deep") caused by the heavily-generic DeepAgent type.
 */
interface StreamableAgent {
  streamEvents(
    input: {
      messages: DeepAgentMessage[];
    },
    options: {
      version: 'v1' | 'v2';
      configurable?: {
        harnessConfig: LangGraphConfig;
        agentId: string;
        conversationId: string;
        workspaceDir?: string;
      };
    },
  ): AsyncIterable<StreamEvent>;
}

interface DeepAgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepAgentMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  tool_call_id?: string;
  tool_calls?: DeepAgentToolCall[];
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
  readonly enforcementCapabilities =
    TURN_ONLY_ENFORCEMENT_CAPABILITIES;

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
    return withTurnTracing(session, config, this.name);
  }
}

class LangGraphSession implements HarnessSession {
  private transcript: Message[] = [];
  private readonly harnessConfig: LangGraphConfig;

  constructor(private readonly config: HarnessSessionConfig) {
    this.harnessConfig = parseHarnessConfig(LangGraphConfigSchema, config.harnessConfigJson);
  }

  restoreTranscript(messages: Message[]): void {
    this.transcript = [...messages];
  }

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent> {
    const { agentId, conversationId, workspaceDir, tools, systemPrompt } = this.config;
    const turnSecrets = context.turnSecrets ?? {};
    const effectiveSecrets = {
      ...this.config.secrets,
      ...turnSecrets,
    };

    const ac = new AbortController();
    const unlinkAbort = linkTurnAbort(this.config.signal, context.signal, () => ac.abort());

    try {
      this.transcript = [...input.messages];
      const accumulator = new TurnAccumulator({ turnId: input.turnId });
      const queuedEvents: AgentEvent[] = [];
      const drainQueuedEvents = () => queuedEvents.splice(0);

      // Step 1: Resolve the chat model from config + secrets
      const chatModel = await this.buildModelFromConfig(
        effectiveSecrets,
        input.turnId,
      );

      // Step 2: Build tool execution context
      const ctx = {
        agentId,
        conversationId,
        turnId: input.turnId,
        workspaceDir: workspaceDir ?? process.cwd(),
      };

      // Step 3: Determine effective approval callback (turn-level takes precedence)
      const onApprovalNeeded = context.onApprovalNeeded ?? this.config.onApprovalNeeded;

      // Step 4: Build langchain tools that wrap our tool definitions
      const lcTools = this.buildLangChainTools(ctx, input.turnId, tools, onApprovalNeeded, queuedEvents);

      // Step 5: Create the deep agent with LocalShellBackend for full filesystem/shell capabilities
      const { createDeepAgent, LocalShellBackend } = await this.loadDeepAgentsModule();
      const backend = new LocalShellBackend({
        rootDir: workspaceDir ?? process.cwd(),
        env: {
          ...process.env,
          ...turnSecrets,
        } as Record<string, string>,
      });

      // Load workspace middleware once — used for both main agent and subagent propagation
      const workspaceMiddleware: Record<string, unknown>[] = [];
      for (const mwPath of (this.harnessConfig.middleware ?? [])) {
        try {
          const resolved = path.resolve(workspaceDir ?? process.cwd(), mwPath);
          const mod = await import(resolved);
          const mw = mod.default ?? mod;
          workspaceMiddleware.push(typeof mw === 'function' ? mw() : mw);
        } catch (err) {
          console.error(`[langgraph] Failed to load middleware: ${mwPath}`, err);
        }
      }

      const resolvedSubagents = await this.buildSubagentParams(
        this.harnessConfig.subagents,
        lcTools,
        workspaceMiddleware,
        effectiveSecrets,
        input.turnId,
      );

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
      const nativeToolPolicy = this.config.nativeToolPolicy;
      if (nativeToolPolicy && nativeToolPolicy.policy !== 'all') {
        middlewares.push(this.createNativeToolPolicyMiddleware(
          nativeToolPolicy,
          new Set(tools.map((tool) => tool.name)),
        ));
      }

      middlewares.push(...workspaceMiddleware);

      deepAgentParams.middleware = middlewares;

      const agent = createDeepAgent(deepAgentParams as Parameters<typeof createDeepAgent>[0]) as unknown as StreamableAgent;

      // Step 6: Convert full transcript to deepagents message format
      const langchainMessages = this.transcript
        .map((m) => this.toDeepAgentMessage(m));

      // Step 7: Stream events from the agent, accumulating assistant text for transcript
      const eventStream = agent.streamEvents(
        { messages: langchainMessages },
        {
          version: 'v2',
          configurable: {
            harnessConfig: this.harnessConfig,
            agentId: this.config.agentId,
            conversationId: this.config.conversationId,
            workspaceDir,
          },
        },
      );

      const pendingToolCalls: Array<{ id: string; name: string }> = [];
      const toolRunIdToInfo = new Map<string, { toolCallId: string; startTime: number }>();
      const usageByModelRunId = new Map<string, TokenUsage>();
      let turnOnlyUsage: TokenUsage | undefined;

      for await (const ev of makeIterableAbortable(eventStream, ac.signal)) {
        for (const queuedEvent of drainQueuedEvents()) {
          yield queuedEvent;
        }

        const event = ev.event;
        const data = ev.data;

        if (event === 'on_chat_model_stream') {
          const chunk = data.chunk;
          if (!chunk) continue;
          const observedUsage = this.extractUsage(data);
          if (observedUsage) {
            if (typeof ev.run_id === 'string' && ev.run_id.length > 0) {
              usageByModelRunId.set(ev.run_id, observedUsage);
            } else {
              turnOnlyUsage = observedUsage;
            }
          }

          for (const textDelta of normalizeStreamTextDeltas(chunk.content)) {
            yield accumulator.appendText(textDelta);
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

        if (event === 'on_chat_model_end') {
          const observedUsage = this.extractUsage(data);
          if (observedUsage) {
            if (typeof ev.run_id === 'string' && ev.run_id.length > 0) {
              usageByModelRunId.set(ev.run_id, observedUsage);
            } else {
              turnOnlyUsage = observedUsage;
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

          const toolStartEvent = {
            type: 'tool_call_start',
            id: toolCallId,
            name: toolName,
            args: fullArgs,
          } as const;
          yield toolStartEvent;

          accumulator.recordToolStart({
            id: toolCallId,
            name: toolName,
            args: fullArgs,
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
          accumulator.recordToolEnd({ id: toolCallId, result: resultStr });
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
          const errMsg = errorMessage(rawErr ?? 'Unknown tool error');

          yield {
            type: 'tool_call_end',
            id: toolCallId,
            result: errMsg,
            error: errMsg,
            durationMs,
          };
          accumulator.recordToolEnd({ id: toolCallId, result: errMsg, error: errMsg });
        }
      }

      for (const queuedEvent of drainQueuedEvents()) {
        yield queuedEvent;
      }

      const usage = usageByModelRunId.size > 0
        ? this.sumUsage([...usageByModelRunId.values()])
        : turnOnlyUsage;
      accumulator.recordDone({
        type: 'done',
        ...(usage ? { usage } : {}),
      });
      yield* finalizeTurn(accumulator, this.transcript, agentId);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      console.error('[langgraph] deliverTurn error:', err);
      yield { type: 'error', error: String(err) };
    } finally {
      unlinkAbort();
    }
  }

  async exportState(): Promise<HarnessExportedState> {
    return {
      stateVersion: '2',
      payload: { transcript: this.transcript },
    };
  }

  async close(): Promise<void> {
    // Stateless — deepagents creates a fresh agent per turn, nothing to tear down
  }

  private toDeepAgentMessage(message: Message): DeepAgentMessage {
    const converted: DeepAgentMessage = {
      role: message.role,
      content: message.content,
    };

    if (message.role === 'tool' && message.toolCallId) {
      converted.tool_call_id = message.toolCallId;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      converted.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments ?? {}),
        },
      }));
    }

    return converted;
  }

  private createNativeToolPolicyMiddleware(
    nativeToolPolicy: NonNullable<HarnessSessionConfig['nativeToolPolicy']>,
    ctxmillToolNames: ReadonlySet<string>,
  ): Record<string, unknown> {
    return {
      name: 'ctxmill-native-tool-policy',
      beforeToolCall: (call: { name: string }) => {
        if (ctxmillToolNames.has(call.name) || isNativeToolAllowed(nativeToolPolicy, call.name)) {
          return { blocked: false };
        }
        return {
          blocked: true,
          reason: `Native tool '${call.name}' is denied by nativeToolPolicy '${nativeToolPolicy.policy}'`,
        };
      },
    };
  }

  private extractUsage(data: Record<string, unknown>): TokenUsage | undefined {
    for (const value of [data.output, data.chunk]) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const usage = normalizeTokenUsage(
        record.usage_metadata as Record<string, unknown> | undefined,
      );
      if (usage) return usage;

      const responseMetadata = record.response_metadata;
      if (
        typeof responseMetadata === 'object'
        && responseMetadata !== null
        && !Array.isArray(responseMetadata)
      ) {
        const responseRecord = responseMetadata as Record<string, unknown>;
        const responseUsage = normalizeTokenUsage(
          (responseRecord.tokenUsage ?? responseRecord.usage) as
            | Record<string, unknown>
            | undefined,
        );
        if (responseUsage) return responseUsage;
      }
    }

    return normalizeTokenUsage(data.usage as Record<string, unknown> | undefined);
  }

  private sumUsage(entries: TokenUsage[]): TokenUsage {
    const total = entries.reduce<TokenUsage>((sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
      ...(sum.costUsd !== undefined && usage.costUsd !== undefined
        ? { costUsd: sum.costUsd + usage.costUsd }
        : {}),
    }), {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      ...(entries.every((usage) => usage.costUsd !== undefined)
        ? { costUsd: 0 }
        : {}),
    });
    return total;
  }

  private async buildModelFromConfig(
    secrets: ResolvedSecrets,
    turnId?: string,
  ): Promise<BaseLanguageModel> {
    return this.buildModelForConfig(this.harnessConfig, secrets, turnId);
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
    topP?: number;
    reasoning?: 'off' | 'low' | 'medium' | 'high';
  }, secrets: ResolvedSecrets, turnId?: string): Promise<BaseLanguageModel> {
    const { provider, model, apiKeyRef, baseUrl, temperature, maxTokens, topP, reasoning } = config;
    const connection = resolveHarnessModelConnection({
      provider,
      apiKeyRef,
      baseUrl,
      secrets,
    });
    const correlationHeaders = connection.mode === 'gateway' && turnId
      ? createGatewayCorrelationHeaders(turnId)
      : undefined;

    if (provider === 'anthropic') {
      const { ChatAnthropic } = await import('@langchain/anthropic');
      return new ChatAnthropic({
        anthropicApiKey: connection.apiKey,
        anthropicApiUrl: connection.baseUrl,
        ...(correlationHeaders
          ? { clientOptions: { defaultHeaders: correlationHeaders } }
          : {}),
        model,
        modelName: model,
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxTokens } : {}),
        ...(topP != null ? { topP } : {}),
      }) as unknown as BaseLanguageModel;
    } else if (provider === 'google') {
      const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
      return new ChatGoogleGenerativeAI({
        apiKey: connection.apiKey,
        model,
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
        ...(topP != null ? { topP } : {}),
      }) as unknown as BaseLanguageModel;
    } else {
      const { ChatOpenAI } = await import('@langchain/openai');
      return new ChatOpenAI({
        apiKey: connection.apiKey,
        configuration: connection.baseUrl || correlationHeaders
          ? {
              ...(connection.baseUrl ? { baseURL: connection.baseUrl } : {}),
              ...(correlationHeaders ? { defaultHeaders: correlationHeaders } : {}),
            }
          : undefined,
        modelName: model,
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { maxTokens } : {}),
        ...(topP != null ? { topP } : {}),
        ...(reasoning && reasoning !== 'off' ? { reasoning_effort: reasoning } : {}),
      }) as unknown as BaseLanguageModel;
    }
  }

  private async buildSubagentParams(
    subagentConfigs: LangGraphConfig['subagents'],
    parentTools?: unknown[],
    workspaceMiddleware?: Record<string, unknown>[],
    secrets: ResolvedSecrets = this.config.secrets,
    turnId?: string,
  ): Promise<Record<string, unknown>[] | undefined> {
    if (!subagentConfigs?.length) return undefined;

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
          }, secrets, turnId);
        }

        if (config.tools && parentTools) {
          const resolved = config.tools
            .map((name: string) => toolsByName.get(name))
            .filter((t): t is NonNullable<typeof t> => t != null);
          if (resolved.length > 0) result.tools = resolved;
        }

        if (workspaceMiddleware?.length) {
          result.middleware = [...workspaceMiddleware];
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
      turnId?: string;
      workspaceDir: string;
    },
    turnId: string,
    toolDefs: import('../tool/types.js').ToolDefinition[],
    onApprovalNeeded: import('./types.js').ApprovalCallback | undefined,
    queuedEvents: AgentEvent[] = [],
  ) {
    return toolDefs.map((def) => {
      return lcTool(
        async (args: Record<string, unknown>) => {
          // HITL: if the tool requires approval, delegate to onApprovalNeeded callback
          if (def.requiresApproval) {
            if (onApprovalNeeded) {
              const approval = await requestToolApproval({
                id: randomUUID(),
                turnId,
                toolName: def.name,
                args: args as Record<string, unknown>,
                onApprovalNeeded,
                emit: (event) => queuedEvents.push(event),
              });
              if (!approval.approved) {
                return approval.rejectionMessage;
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
            const msg = errorMessage(handlerErr);
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

        const msg = errorMessage(err);
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
