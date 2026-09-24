import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { query as sdkQuery, createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentHarness,
  AgentEvent,
  ApprovalRequest,
  ApprovalCallback,
  HarnessSessionConfig,
  HarnessSession,
  HarnessRestorePoint,
  HarnessTurnInput,
  HarnessTurnContext,
  HarnessExportedState,
  TokenUsage,
} from './types.js';
import type { ToolContext, ToolDefinition } from '../tool/types.js';
import type { Message } from '../types.js';
import {
  normalizeStreamTextDeltas,
} from './shared.js';
import { ClaudeAgentsConfigSchema, type ClaudeAgentsConfig } from './schemas.js';
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
import {
  createGatewayCorrelationHeaders,
  resolveHarnessModelConnection,
  type HarnessModelConnection,
} from './model-gateway.js';
import type { ModelCallDecision } from './enforcement/types.js';
import {
  FanoutLimitHarnessTurnEnforcer,
  fanoutLimitMessage,
  fanoutTelemetryEvent,
} from './enforcement/fanout.js';

type JsonRecord = Record<string, unknown>;

type ZodSchemaLike = {
  safeParse: (value: unknown) => unknown;
};

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface ConvertedMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
}

type SdkPromptMessage = {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
};

type SDKUserMessage = Extract<SDKMessage, { type: 'user' }>;
type SDKResultMessage = Extract<SDKMessage, { type: 'result' }>;
type SDKErrorResultMessage = Exclude<SDKResultMessage, { subtype: 'success' }>;
type SDKSystemMessage = Extract<SDKMessage, { type: 'system' }>;
type SDKInitMessage = Extract<SDKSystemMessage, { subtype: 'init' }>;

type SdkToolFactory = (...args: unknown[]) => unknown;

type ClaudeSdkModule = {
  query: typeof sdkQuery;
  tool: SdkToolFactory;
  createSdkMcpServer: typeof createSdkMcpServer;
};

type ToolUseBlock = {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
};

type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

type TextBlock = {
  type: 'text';
  text?: string;
};

type StreamDelta = {
  type?: string;
  text?: string;
  partial_json?: string;
  partialJson?: string;
};

type SdkStreamEvent = {
  type: string;
  index?: number;
  delta?: StreamDelta;
  content_block?: unknown;
  contentBlock?: unknown;
};

type StreamMappingState = {
  sawTextDeltaSinceAssistant: boolean;
  toolCallIdsByIndex: Map<number, string>;
  toolArgsJsonByCallId: Map<string, string>;
  /**
   * Task tool_use id → subagent_type, recorded when the parent spawns the
   * Task. Children arriving with that parent_tool_use_id get labeled with
   * the subagent's identity (ctx-5myn).
   */
  subagentTypeByTaskId: Map<string, string>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Claude Agent SDK (>=0.3.195) requires `sessionId`/`resume` to be a bare
 * UUID and crashes the child process otherwise. stablehand conversation ids are
 * not always UUIDs — AG-UI/embed clients allocate ids like `thread-<uuid>` —
 * so coerce to a stable UUID. Same conversation id → same UUID, so the SDK's
 * session persistence and cross-turn `resume` stay aligned.
 */
export function toSdkSessionId(conversationId: string): string {
  if (UUID_RE.test(conversationId)) {
    return conversationId;
  }
  // `thread-<uuid>` (and similar) carry a usable UUID; prefer it verbatim.
  const embedded = conversationId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (embedded) {
    return embedded[0].toLowerCase();
  }
  // Otherwise derive a deterministic v4-shaped UUID from the id.
  const h = createHash('sha256').update(conversationId).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

class ClaudeSession implements HarnessSession {
  private transcript: Message[] = [];
  private readonly queuedEvents: AgentEvent[] = [];
  private activeApprovalHandler: ApprovalCallback | undefined;
  private readonly mcpServer: ReturnType<typeof createSdkMcpServer>;
  private restoredFromCheckpoint = false;
  private sdkSessionId: string;

  constructor(
    private readonly config: HarnessSessionConfig,
    private readonly harnessConfig: ClaudeAgentsConfig,
    private readonly connection: HarnessModelConnection,
    private readonly harness: ClaudeAgentsHarness,
    private readonly sdk: ClaudeSdkModule,
  ) {
    const approvalDelegate = this.makeApprovalDelegate();
    const mcpTools = harness.convertToolsWithSDK(
      { tool: sdk.tool },
      config.tools,
      config.conversationId,
      config,
      approvalDelegate,
      this.queuedEvents,
    );
    this.mcpServer = sdk.createSdkMcpServer({ name: 'stablehand', tools: mcpTools });
    this.sdkSessionId = toSdkSessionId(config.conversationId);
  }

  setSdkSessionId(sessionId: string): void {
    // Coerce here too: a restored checkpoint may carry a pre-fix (non-UUID) id.
    this.sdkSessionId = toSdkSessionId(sessionId);
  }

  restoreTranscript(messages: Message[], options?: { markRestoredFromCheckpoint?: boolean }): void {
    this.transcript.push(...messages);
    this.restoredFromCheckpoint = options?.markRestoredFromCheckpoint ?? true;
  }

  async restoreSessionJSONL(jsonlContent: string): Promise<void> {
    for (const sessionPath of this.resolveSessionJSONLPaths()) {
      await fs.mkdir(path.dirname(sessionPath), { recursive: true });
      await fs.writeFile(sessionPath, jsonlContent, 'utf-8');
    }
  }

  private resolveSessionJSONLPaths(): string[] {
    const configDir = process.env.CLAUDE_CONFIG_DIR
      ?? path.join(process.env.HOME ?? '/home/stablehand', '.claude');
    const workspaceDir = this.config.workspaceDir || '/workspace';
    const sessionId = this.sdkSessionId;
    const sanitizedWorkspaceDir = workspaceDir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
    const hashedWorkspaceDir = createHash('sha256').update(workspaceDir).digest('hex');
    const projectDirs = [...new Set([sanitizedWorkspaceDir, hashedWorkspaceDir])];

    return projectDirs.map((projectDir) =>
      path.join(configDir, 'projects', projectDir, 'sessions', `${sessionId}.jsonl`),
    );
  }

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent> {
    const hasLocalTranscript = this.transcript.length > 0;
    const shouldReplayFullPrompt = !this.restoredFromCheckpoint && !hasLocalTranscript && input.messages.length > 1;
    if (shouldReplayFullPrompt) {
      this.sdkSessionId = input.turnId;
    }
    const isFirstTurn = this.restoredFromCheckpoint || !hasLocalTranscript;
    this.transcript = [...input.messages];
    this.activeApprovalHandler = context.onApprovalNeeded ?? this.config.onApprovalNeeded;

    const abortController = new AbortController();
    const cleanupAbort = linkTurnAbort(
      this.config.signal,
      context.signal,
      () => abortController.abort(),
    );
    const toolStartTimes = new Map<string, number>();
    const streamState = this.harness.createStreamMappingState();
    const accumulator = new TurnAccumulator({ turnId: input.turnId });
    let fanoutError: string | undefined;

    try {
      const maxTurns = this.harnessConfig.maxTurns;
      const sdkSessionId = this.sdkSessionId;
      const agents = this.harnessConfig.subagents;

      const q = this.sdk.query({
        prompt: this.generateInput(input.messages, { replayAllMessages: shouldReplayFullPrompt }),
        options: {
          model: this.harnessConfig.model,
          systemPrompt: this.config.systemPrompt,
          cwd: this.config.workspaceDir,
          settingSources: ['project'],
          allowedTools: this.buildAllowedTools() ?? [],
          disallowedTools: this.buildDisallowedTools() ?? [],
          mcpServers: { stablehand: this.mcpServer },
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          includeHookEvents: true,
          // Token-level text streaming: content_block_delta events feed
          // text_delta as they arrive; mapSDKMessage dedupes against the
          // complete assistant message via sawTextDeltaSinceAssistant.
          includePartialMessages: true,
          persistSession: true,
          ...(agents ? { agents } : {}),
          ...(isFirstTurn ? { sessionId: sdkSessionId } : { resume: sdkSessionId }),
          abortController,
          env: this.buildClaudeEnv(context.turnSecrets, input.turnId),
          ...(maxTurns != null ? { maxTurns } : {}),
        },
      } as Parameters<typeof sdkQuery>[0]);

      const enforcer = this.config.turnEnforcer;
      for await (const message of q) {
        yield* this.flushQueuedEvents();
        // One completed assistant message per model call — parent and
        // subagent alike — so counting them enforces the cap across every
        // parallel Task branch the out-of-process SDK spawns.
        if (enforcer && !fanoutError && message.type === 'assistant') {
          const decision = await enforcer.afterModelCall({
            turnId: input.turnId,
            provider: 'anthropic',
            model: this.harnessConfig.model,
          });
          if (decision.action !== 'continue') {
            const trip = this.buildFanoutTrip(decision);
            yield* trip.events;
            fanoutError = trip.message;
            abortController.abort();
          }
        }
        for (const event of this.harness.mapSDKMessage(message, toolStartTimes, streamState)) {
          if (event.type === 'tool_call_start' && enforcer?.onToolBoundary && !fanoutError) {
            const decision = await enforcer.onToolBoundary({
              turnId: input.turnId,
              toolName: event.name,
              subagent: event.name === 'Task' || event.name === 'Agent',
            });
            if (decision.action !== 'continue') {
              const trip = this.buildFanoutTrip(decision);
              yield* trip.events;
              fanoutError = trip.message;
              abortController.abort();
            }
          }
          if (event.type === 'text_delta' && typeof event.content === 'string') {
            accumulator.appendText(event.content);
          }

          if (event.type === 'tool_call_start') {
            accumulator.recordToolStart({
              id: event.id,
              name: event.name,
              args: event.args,
            });
          } else if (event.type === 'tool_call_end' && event.error) {
            accumulator.recordToolEnd({
              id: event.id,
              result: event.result,
              error: event.error,
            });
          }

          if (event.type === 'done') {
            accumulator.recordDone(event);
            if (!accumulator.hasCommitContent() && typeof event.result === 'string') {
              accumulator.recordAssistantText(event.result);
            }
            continue;
          }

          yield event;
        }
        yield* this.flushQueuedEvents();
      }

      if (this.restoredFromCheckpoint) {
        this.restoredFromCheckpoint = false;
      }

      yield* this.flushQueuedEvents();
      if (fanoutError) {
        yield { type: 'error', error: fanoutError };
        fanoutError = undefined;
      }
      yield* finalizeTurn(
        accumulator,
        this.transcript,
        this.config.agentId ?? this.config.conversationId,
      );
    } catch (error) {
      console.error('[claude-agents] deliverTurn error:', error);
      yield* this.flushQueuedEvents();
      yield { type: 'error', error: fanoutError ?? errorMessage(error) };
    } finally {
      cleanupAbort();
    }
  }

  async exportState(): Promise<HarnessExportedState> {
    let sessionJSONL: string | undefined;
    for (const sessionPath of this.resolveSessionJSONLPaths()) {
      try {
        sessionJSONL = await fs.readFile(sessionPath, 'utf-8');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    return {
      stateVersion: '2',
      payload: {
        transcript: this.transcript,
        sessionId: this.sdkSessionId,
        ...(sessionJSONL != null ? { sessionJSONL } : {}),
      },
    };
  }

  async close(): Promise<void> {}

  private buildFanoutTrip(
    decision: Exclude<ModelCallDecision, { action: 'continue' }>,
  ): { events: AgentEvent[]; message: string } {
    const enforcer = this.config.turnEnforcer;
    const events: AgentEvent[] = [];
    let message = `Turn stopped: the ${decision.reason} safety cap was reached.`;
    if (enforcer instanceof FanoutLimitHarnessTurnEnforcer) {
      message = fanoutLimitMessage(decision.reason, enforcer.limits);
      if (enforcer.takeFirstTrip(decision.reason)) {
        events.push({
          type: 'custom_agui_event',
          event: fanoutTelemetryEvent('claude-agents', decision.reason, decision.action, enforcer.snapshot()),
        });
      }
    }
    return { events, message };
  }

  private makeApprovalDelegate(): ApprovalCallback {
    return async (req: ApprovalRequest) => {
      const handler = this.activeApprovalHandler;
      if (!handler) {
        return { action: 'approve' };
      }
      return handler(req);
    };
  }

  private *flushQueuedEvents(): Generator<AgentEvent> {
    while (this.queuedEvents.length > 0) {
      const nextEvent = this.queuedEvents.shift();
      if (nextEvent) {
        yield nextEvent;
      }
    }
  }

  private async *generateInput(
    messages: Message[],
    options: { replayAllMessages?: boolean } = {},
  ): AsyncGenerator<SdkPromptMessage> {
    if ((this.restoredFromCheckpoint || options.replayAllMessages) && messages.length > 1) {
      for (const message of messages) {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: this.formatRestoredPromptMessage(message),
          },
        };
      }
      return;
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) {
      return;
    }

    yield {
      type: 'user',
      message: {
        role: 'user',
        content: lastMsg.content,
      },
    };
  }

  private formatRestoredPromptMessage(message: Message): string {
    switch (message.role) {
      case 'assistant':
        return this.formatRestoredAssistantMessage(message);
      case 'system':
        return `[Previous system message]\n${message.content}`;
      case 'tool':
        return message.toolCallId
          ? `[Previous tool output (${message.toolCallId})]\n${message.content}`
          : `[Previous tool output]\n${message.content}`;
      case 'user':
      default:
        return message.content;
    }
  }

  private formatRestoredAssistantMessage(message: Message): string {
    const parts = [`[Previous assistant response]\n${message.content}`];
    if (message.toolCalls?.length) {
      const calls = message.toolCalls.map((toolCall) => {
        const args = this.stringifyRestoredToolArgs(toolCall.arguments ?? {});
        return `- ${toolCall.id}: ${toolCall.name} ${args}`;
      });
      parts.push(`[Previous assistant tool calls]\n${calls.join('\n')}`);
    }
    return parts.join('\n');
  }

  private stringifyRestoredToolArgs(args: unknown): string {
    if (typeof args === 'string') {
      return args;
    }

    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }

  private buildAllowedTools(): string[] | undefined {
    const nativeToolPolicy = this.config.nativeToolPolicy;
    if (!nativeToolPolicy || nativeToolPolicy.policy === 'all' || nativeToolPolicy.policy === 'deny') {
      return undefined;
    }
    if (nativeToolPolicy.policy === 'none') {
      return ['mcp__stablehand__*'];
    }
    return [...new Set([...nativeToolPolicy.names, 'mcp__stablehand__*'])];
  }

  private buildDisallowedTools(): string[] | undefined {
    const nativeToolPolicy = this.config.nativeToolPolicy;
    return nativeToolPolicy?.policy === 'deny' ? [...nativeToolPolicy.names] : undefined;
  }

  private buildClaudeEnv(
    turnSecrets: Readonly<Record<string, string>> = {},
    turnId?: string,
  ): Record<string, string> {
    const claudeEnv: Record<string, string> = {
      HOME: process.env.HOME ?? '/home/stablehand',
      PATH:
        process.env.PATH ??
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ...(this.connection.apiKey
        ? { ANTHROPIC_API_KEY: this.connection.apiKey }
        : {}),
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      ...(this.connection.baseUrl
        ? { ANTHROPIC_BASE_URL: this.connection.baseUrl }
        : {}),
      ...(this.connection.mode === 'gateway' && turnId
        ? {
            ANTHROPIC_CUSTOM_HEADERS: Object.entries(
              createGatewayCorrelationHeaders(turnId),
            ).map(([key, value]) => `${key}: ${value}`).join('\n'),
          }
        : {}),
    };
    // Keys that must never be forwarded into the agent env — either because
    // they're irrelevant to the Claude Code subprocess (model overrides) or
    // because they are secret credentials that would appear in LangSmith
    // trace inputs.options.env when LANGSMITH_TRACING=true.
    const ENV_BLOCKLIST: ReadonlySet<string> = new Set([
      // Model override keys — prevent these from clobbering the explicit
      // model option passed to the SDK.
      'OPENAI_MODEL',
      'ANTHROPIC_MODEL',
      'MODEL',
      'CLAUDE_MODEL',
      // LLM provider credentials — not needed by the agent subprocess; the
      // only key it needs is ANTHROPIC_API_KEY which is already set above.
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GEMINI_API_KEY',
      'COHERE_API_KEY',
      'MISTRAL_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_ENDPOINT',
      // Observability / tracing credentials.
      'LANGSMITH_API_KEY',
      'LANGSMITH_ENDPOINT',
      'LANGSMITH_WORKSPACE_ID',
      'LANGFUSE_SECRET_KEY',
      'LANGFUSE_PUBLIC_KEY',
      'LANGFUSE_HOST',
      'OTEL_EXPORTER_OTLP_HEADERS',
      // Object-storage credentials (MinIO / S3 / GCS).
      'S3_SECRET_KEY',
      'S3_ACCESS_KEY',
      'MINIO_ROOT_USER',
      'MINIO_ROOT_PASSWORD',
      'MINIO_ACCESS_KEY',
      'MINIO_SECRET_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SESSION_TOKEN',
      'GCS_KEY_FILE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      // Database / broker connection strings.
      'DATABASE_URL',
      'REDIS_URL',
      'POSTGRES_PASSWORD',
      'POSTGRES_URL',
      // Auth-service secrets.
      'WORKOS_API_KEY',
      'WORKOS_CLIENT_SECRET',
      'JWT_SECRET',
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
      'NEXTAUTH_SECRET',
      // Notification / webhook secrets.
      'NOVU_API_KEY',
      'NOVU_SECRET_KEY',
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      // Deployment-owned gateway access is translated into the one native
      // Anthropic credential and endpoint above. Do not forward the control
      // namespace itself into the child process.
      'STABLEHAND_MODEL_GATEWAY_ENABLED',
      'STABLEHAND_MODEL_GATEWAY_URL',
      'STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY',
      'STABLEHAND_MODEL_GATEWAY_REVISION',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !(k in claudeEnv) && !ENV_BLOCKLIST.has(k)) claudeEnv[k] = v;
    }
    for (const [k, v] of Object.entries(turnSecrets)) {
      if (
        this.connection.mode === 'gateway'
        && (
          k === 'ANTHROPIC_API_KEY'
          || k === 'ANTHROPIC_BASE_URL'
          || k === 'ANTHROPIC_CUSTOM_HEADERS'
          || k.startsWith('STABLEHAND_MODEL_GATEWAY_')
        )
      ) {
        continue;
      }
      claudeEnv[k] = v;
    }
    return claudeEnv;
  }

}

export class ClaudeAgentsHarness implements AgentHarness {
  readonly name = 'claude-agents';
  readonly configSchema = ClaudeAgentsConfigSchema;
  readonly enforcementCapabilities = {
    observationBoundary: 'after_only',
    activeCallCancellation: true,
    softStop: false,
  } as const;

  protected async loadSdkModule(): Promise<ClaudeSdkModule> {
    const baseSdk: ClaudeSdkModule = {
      query: sdkQuery,
      tool: sdkTool as unknown as SdkToolFactory,
      createSdkMcpServer,
    };

    return baseSdk;
  }

  async openSession(
    config: HarnessSessionConfig,
    restore?: HarnessRestorePoint,
  ): Promise<HarnessSession> {
    const sdk = await this.loadSdkModule();
    const harnessConfig = parseHarnessConfig(ClaudeAgentsConfigSchema, config.harnessConfigJson);
    const connection = resolveHarnessModelConnection({
      provider: 'anthropic',
      apiKeyRef: harnessConfig.apiKeyRef,
      baseUrl: harnessConfig.baseUrl,
      secrets: config.secrets,
    });

    if (!connection.apiKey) {
      throw new Error('Missing Anthropic API key for claude-agents harness.');
    }

    const session = new ClaudeSession(
      config,
      harnessConfig,
      connection,
      this,
      sdk,
    );
    if (restore) {
      const sdkSessionId = restore.payload['sessionId'];
      if (typeof sdkSessionId === 'string' && sdkSessionId.length > 0) {
        session.setSdkSessionId(sdkSessionId);
      }

      const sessionJSONL = restore.payload['sessionJSONL'];
      const hasRestoredSessionJSONL = typeof sessionJSONL === 'string';
      if (hasRestoredSessionJSONL) {
        await session.restoreSessionJSONL(sessionJSONL);
      }

      const transcriptFromState = restore.payload['transcript'];
      if (Array.isArray(transcriptFromState) && transcriptFromState.length > 0) {
        session.restoreTranscript(transcriptFromState as Message[], {
          markRestoredFromCheckpoint: !hasRestoredSessionJSONL,
        });
      } else if (restore.messages.length > 0) {
        session.restoreTranscript(restore.messages, {
          markRestoredFromCheckpoint: !hasRestoredSessionJSONL,
        });
      }
    }
    return withTurnTracing(session, config, this.name);
  }

  convertToolsWithSDK(
    sdk: { tool: SdkToolFactory },
    toolDefs: ToolDefinition[],
    turnId: string,
    config?: HarnessSessionConfig,
    onApprovalNeeded?: ApprovalCallback,
    queuedEvents?: AgentEvent[],
  ): ConvertedMcpTool[] {
    return toolDefs.map((definition) => {
      const inputSchema = this.requireZodSchema(definition.input, definition.name);

      return sdk.tool(
        definition.name,
        definition.description,
        inputSchema,
        async (rawArgs: unknown) => {
          const args = this.toArgsRecord(rawArgs);
          const approvalId = randomUUID();

          if (definition.requiresApproval && onApprovalNeeded) {
            const approval = await requestToolApproval({
              id: approvalId,
              turnId,
              toolName: definition.name,
              args,
              onApprovalNeeded,
              emit: (event) => queuedEvents?.push(event),
            });

            if (!approval.approved) {
              return {
                content: [{ type: 'text', text: approval.rejectionMessage }],
                isError: true,
              };
            }
          }

          try {
            const result = await definition.handler(
              args,
              this.createToolContext(config, turnId),
            );

            return {
              content: [{ type: 'text', text: this.stringifyResult(result) }],
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: errorMessage(error) }],
              isError: true,
            };
          }
        },
      ) as ConvertedMcpTool;
    });
  }

  createStreamMappingState(): StreamMappingState {
    return {
      sawTextDeltaSinceAssistant: false,
      toolCallIdsByIndex: new Map<number, string>(),
      toolArgsJsonByCallId: new Map<string, string>(),
      subagentTypeByTaskId: new Map<string, string>(),
    };
  }

  /**
   * Subagent children start streaming before the parent-side assistant
   * message (whose complete blocks record the map), so fall back to the
   * streamed-args buffer: by the time a child exists, the spawning call's
   * input has fully streamed.
   */
  private lookupSubagentType(streamState: StreamMappingState, taskId: string): string | undefined {
    const known = streamState.subagentTypeByTaskId.get(taskId);
    if (known) return known;
    const buffered = streamState.toolArgsJsonByCallId.get(taskId);
    if (!buffered) return undefined;
    try {
      const parsed = JSON.parse(buffered) as { subagent_type?: unknown };
      if (typeof parsed.subagent_type === 'string' && parsed.subagent_type.length > 0) {
        streamState.subagentTypeByTaskId.set(taskId, parsed.subagent_type);
        return parsed.subagent_type;
      }
    } catch { /* input still streaming or non-JSON — no label */ }
    return undefined;
  }

  *mapSDKMessage(
    message: SDKMessage,
    toolStartTimes: Map<string, number>,
    streamState: StreamMappingState = this.createStreamMappingState(),
  ): Generator<AgentEvent> {
    // Non-null on every message emitted inside a Task subagent (including
    // stream deltas): the id of the spawning Task tool_use. Subagent tool
    // activity is annotated with it so the UI can nest; subagent prose is
    // suppressed from the parent stream — the Task card's result carries the
    // subagent's report, and splicing narration into the parent's committed
    // message corrupts it (ctx-5myn).
    const parentTaskId = typeof (message as { parent_tool_use_id?: unknown }).parent_tool_use_id === 'string'
      ? (message as { parent_tool_use_id: string }).parent_tool_use_id
      : undefined;
    switch (message.type) {
      case 'system': {
        const hookEvent = this.toHookTelemetryEvent(message);
        if (hookEvent) {
          this.logHookSystemMessage(message);
          yield hookEvent;
          break;
        }

        if (this.isSystemInitMessage(message)) {
          yield this.toRuntimeCapabilitiesEvent(message);
          break;
        }
        break;
      }

      case 'stream_event': {
        const event = this.asStreamEvent(message.event);
        if (!event) {
          break;
        }

        if (event.type === 'content_block_start') {
          const toolUseBlock = this.asToolUseBlock(event.content_block ?? event.contentBlock);
          if (toolUseBlock) {
            const callId = toolUseBlock.id ?? randomUUID();
            if (typeof event.index === 'number') {
              streamState.toolCallIdsByIndex.set(event.index, callId);
            }
            streamState.toolArgsJsonByCallId.set(callId, '');

            // tool_call_start deferred to 'assistant' message where
            // toolUseBlock.input carries the complete arguments.
          }
          break;
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            streamState.sawTextDeltaSinceAssistant = true;
            if (parentTaskId) {
              break; // subagent prose stays out of the parent stream
            }
            yield { type: 'text_delta', content: delta.text };
            break;
          }

          if (delta?.type === 'input_json_delta') {
            this.appendToolArgsDelta(streamState, event.index, delta.partial_json ?? delta.partialJson);
          }
        }
        break;
      }

      case 'assistant': {
        const contentBlocks = this.getContentBlocks(message.message);

        if (!streamState.sawTextDeltaSinceAssistant && !parentTaskId) {
          for (const contentBlock of contentBlocks) {
            const textBlock = this.asTextBlock(contentBlock);
            if (textBlock?.text) {
              yield { type: 'text_delta', content: textBlock.text };
            }
          }
        }

        for (const contentBlock of contentBlocks) {
          const toolUseBlock = this.asToolUseBlock(contentBlock);
          if (!toolUseBlock) {
            continue;
          }

          const callId = toolUseBlock.id ?? randomUUID();
          if (!this.recordToolStart(toolStartTimes, callId)) {
            continue;
          }

          const args = toolUseBlock.input ?? this.readBufferedToolArgs(streamState, callId) ?? {};
          // The subagent-spawning tool is named 'Task' in older SDKs and
          // 'Agent' in current ones; the args shape is the same.
          if (!parentTaskId && (toolUseBlock.name === 'Task' || toolUseBlock.name === 'Agent')) {
            const subagentType = (args as { subagent_type?: unknown }).subagent_type;
            if (typeof subagentType === 'string' && subagentType.length > 0) {
              streamState.subagentTypeByTaskId.set(callId, subagentType);
            }
          }

          const agentName = parentTaskId
            ? this.lookupSubagentType(streamState, parentTaskId)
            : undefined;
          yield {
            type: 'tool_call_start',
            id: callId,
            name: toolUseBlock.name ?? 'unknown',
            args,
            ...(parentTaskId
              ? {
                parentToolCallId: parentTaskId,
                ...(agentName ? { agentName } : {}),
              }
              : {}),
          };
        }

        streamState.sawTextDeltaSinceAssistant = false;
        break;
      }

      case 'user': {
        const resultBlocks = this.extractToolResultBlocks(message);
        for (const toolResultBlock of resultBlocks) {
          const callId = toolResultBlock.tool_use_id ?? message.parent_tool_use_id ?? randomUUID();
          const startedAt = toolStartTimes.get(callId) ?? Date.now();
          const durationMs = Date.now() - startedAt;
          toolStartTimes.delete(callId);

          const result = this.stringifyToolResultContent(toolResultBlock.content);
          const error = toolResultBlock.is_error
            ? (result || 'Tool call was rejected by the user.')
            : undefined;

          yield {
            type: 'tool_call_end',
            id: callId,
            result,
            ...(error ? { error } : {}),
            durationMs,
            ...(parentTaskId ? { parentToolCallId: parentTaskId } : {}),
          };
        }
        break;
      }

      case 'result': {
        const usage = this.extractUsage(message);
        if (message.subtype === 'success') {
          yield { type: 'done', result: message.result, usage };
          break;
        }

        yield {
          type: 'error',
          error: this.extractResultError(message),
        };
        break;
      }

      default:
        break;
    }
  }

  private createToolContext(
    config: HarnessSessionConfig | undefined,
    turnId: string,
  ): ToolContext {
    return {
      agentId: config?.agentId ?? '',
      conversationId: config?.conversationId ?? turnId,
      turnId,
      workspaceDir: config?.workspaceDir ?? process.cwd(),
    };
  }

  private extractUsage(message: SDKResultMessage): TokenUsage | undefined {
    const usage = message.usage;
    if (!usage) {
      return undefined;
    }

    const cost = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined;
    return normalizeTokenUsage({
      ...(usage as Record<string, unknown>),
      ...(cost != null ? { cost } : {}),
    });
  }

  private extractResultError(message: SDKErrorResultMessage): string {
    if (Array.isArray(message.errors) && message.errors.length > 0) {
      return message.errors.join('; ');
    }

    return message.subtype
      ? `Claude agent query failed: ${message.subtype}`
      : 'Claude agent query failed.';
  }

  private extractToolResultBlocks(message: SDKUserMessage): ToolResultBlock[] {
    const contentBlocks = this.getContentBlocks(message.message);
    const fromContent = contentBlocks
      .map((contentBlock) => this.asToolResultBlock(contentBlock))
      .filter((block): block is ToolResultBlock => block !== undefined);

    if (fromContent.length > 0) {
      return fromContent;
    }

    const toolUseResult = message.tool_use_result;
    if (toolUseResult === undefined) {
      return [];
    }

    if (Array.isArray(toolUseResult)) {
      const fromArray = toolUseResult
        .map((entry) => this.toToolResultBlock(entry, message.parent_tool_use_id))
        .filter((block): block is ToolResultBlock => block !== undefined);
      if (fromArray.length > 0) {
        return fromArray;
      }
    }

    const singleBlock = this.toToolResultBlock(toolUseResult, message.parent_tool_use_id);
    return singleBlock ? [singleBlock] : [];
  }

  private toToolResultBlock(
    value: unknown,
    parentToolUseId: string | null,
  ): ToolResultBlock | undefined {
    const directBlock = this.asToolResultBlock(value);
    if (directBlock) {
      return directBlock;
    }

    if (this.isRecord(value)) {
      const toolUseId =
        typeof value.tool_use_id === 'string'
          ? value.tool_use_id
          : parentToolUseId ?? undefined;

      if (
        toolUseId ||
        'content' in value ||
        'is_error' in value
      ) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: value.content ?? value,
          is_error: value.is_error === true,
        };
      }
    }

    if (!parentToolUseId) {
      return undefined;
    }

    return {
      type: 'tool_result',
      tool_use_id: parentToolUseId,
      content: value,
    };
  }

  private appendToolArgsDelta(
    streamState: StreamMappingState,
    index: number | undefined,
    partialJson: string | undefined,
  ): void {
    if (typeof index !== 'number' || typeof partialJson !== 'string') {
      return;
    }

    const callId = streamState.toolCallIdsByIndex.get(index);
    if (!callId) {
      return;
    }

    const current = streamState.toolArgsJsonByCallId.get(callId) ?? '';
    streamState.toolArgsJsonByCallId.set(callId, current + partialJson);
  }

  private readBufferedToolArgs(streamState: StreamMappingState, callId: string): unknown {
    const raw = streamState.toolArgsJsonByCallId.get(callId);
    if (!raw) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      const message = errorMessage(err);
      const preview = raw.slice(0, 200);
      console.error(`[claude-agents] Failed to parse tool args for call ${callId}; surfacing degraded args. Raw: ${preview}`, err);
      return {
        __stablehandDegraded: true,
        __stablehandError: `Failed to parse streamed Claude tool arguments: ${message}`,
        __stablehandRawArgsPreview: preview,
      };
    }
  }

  private recordToolStart(toolStartTimes: Map<string, number>, callId: string): boolean {
    if (toolStartTimes.has(callId)) {
      return false;
    }
    toolStartTimes.set(callId, Date.now());
    return true;
  }

  private getContentBlocks(message: { content?: unknown } | undefined): unknown[] {
    const content = message?.content;
    return Array.isArray(content) ? content : [];
  }

  private asStreamEvent(value: unknown): SdkStreamEvent | undefined {
    return this.isRecord(value) && typeof value.type === 'string'
      ? (value as SdkStreamEvent)
      : undefined;
  }

  private asToolUseBlock(value: unknown): ToolUseBlock | undefined {
    return this.isRecord(value) && value.type === 'tool_use'
      ? (value as ToolUseBlock)
      : undefined;
  }

  private asToolResultBlock(value: unknown): ToolResultBlock | undefined {
    return this.isRecord(value) && value.type === 'tool_result'
      ? (value as ToolResultBlock)
      : undefined;
  }

  private asTextBlock(value: unknown): TextBlock | undefined {
    return this.isRecord(value) && value.type === 'text'
      ? (value as TextBlock)
      : undefined;
  }

  private stringifyToolResultContent(content: unknown): string {
    const deltas = normalizeStreamTextDeltas(content);
    if (deltas.length > 0) {
      return deltas.join('');
    }

    if (typeof content === 'string') {
      return content;
    }

    return this.stringifyResult(content);
  }

  private stringifyResult(result: unknown): string {
    if (typeof result === 'string') {
      return result;
    }

    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }

  private toArgsRecord(args: unknown): Record<string, unknown> {
    return this.isRecord(args) ? args : {};
  }

  private requireZodSchema(input: unknown, toolName: string): ZodSchemaLike {
    if (this.isZodSchemaLike(input)) {
      return input;
    }

    throw new Error(`Tool ${toolName} must provide a Zod schema input for claude-agents.`);
  }

  private isSystemInitMessage(value: SDKSystemMessage): value is SDKInitMessage {
    return value.subtype === 'init';
  }

  private toRuntimeCapabilitiesEvent(value: SDKInitMessage): AgentEvent {
    return {
      type: 'custom_agui_event',
      event: {
        type: 'CUSTOM',
        timestamp: Date.now(),
        runId: '',
        name: 'stablehand.claude.runtime_capabilities',
        subtype: 'claude_runtime_capabilities',
        source: 'claude-agents',
        claudeSessionId: this.hookTelemetryString(value.session_id),
        sdkMessageId: this.hookTelemetryString(value.uuid),
        claudeCodeVersion: value.claude_code_version,
        model: value.model,
        cwd: value.cwd,
        permissionMode: value.permissionMode,
        slashCommands: value.slash_commands,
        supportsGoal: value.slash_commands.includes('goal'),
        tools: value.tools,
        mcpServers: value.mcp_servers,
        agents: value.agents,
        skills: value.skills,
        plugins: value.plugins,
        apiKeySource: value.apiKeySource,
        outputStyle: value.output_style,
      },
    };
  }

  private toHookTelemetryEvent(value: unknown): AgentEvent | null {
    if (!this.isRecord(value)) {
      return null;
    }

    const subtype = value.subtype;
    if (
      subtype !== 'hook_started'
      && subtype !== 'hook_progress'
      && subtype !== 'hook_response'
    ) {
      return null;
    }

    const outputFields = {
      stdout: this.truncateHookTelemetryField(value.stdout),
      stderr: this.truncateHookTelemetryField(value.stderr),
      output: this.truncateHookTelemetryField(value.output),
    };
    const truncated = Object.values(outputFields).some((field) => field.truncated);

    const event = {
      type: 'CUSTOM' as const,
      timestamp: Date.now(),
      runId: '',
      subtype: 'claude_hook',
      source: 'claude-agents',
      lifecycle: String(subtype).replace('hook_', ''),
      hookEvent: this.hookTelemetryString(value.hook_event),
      hookName: this.hookTelemetryString(value.hook_name),
      hookId: this.hookTelemetryString(value.hook_id),
      claudeSessionId: this.hookTelemetryString(value.session_id),
      sdkMessageId: this.hookTelemetryString(value.uuid),
      ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
      ...(typeof value.exit_code === 'number' ? { exitCode: value.exit_code } : {}),
      ...(outputFields.stdout.text ? { stdout: outputFields.stdout.text } : {}),
      ...(outputFields.stderr.text ? { stderr: outputFields.stderr.text } : {}),
      ...(outputFields.output.text ? { output: outputFields.output.text } : {}),
      ...(truncated ? { truncated: true } : {}),
    };

    return { type: 'custom_agui_event', event };
  }

  private logHookSystemMessage(value: unknown): boolean {
    if (!this.isRecord(value)) {
      return false;
    }

    const subtype = value.subtype;
    if (
      subtype !== 'hook_started'
      && subtype !== 'hook_progress'
      && subtype !== 'hook_response'
    ) {
      return false;
    }

    const parts = [
      `[claude-agents] hook ${subtype.replace('hook_', '')}`,
      `event=${this.formatHookLogField(value.hook_event)}`,
      `name=${this.formatHookLogField(value.hook_name)}`,
      `id=${this.formatHookLogField(value.hook_id)}`,
    ];

    if (typeof value.outcome === 'string') {
      parts.push(`outcome=${value.outcome}`);
    }
    if (typeof value.exit_code === 'number') {
      parts.push(`exitCode=${value.exit_code}`);
    }

    const output = this.formatHookLogOutput(value.output);
    if (output) {
      parts.push(`output=${output}`);
    }

    console.log(parts.join(' '));
    return true;
  }

  private formatHookLogField(value: unknown): string {
    return typeof value === 'string' && value.length > 0 ? value : 'unknown';
  }

  private hookTelemetryString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private truncateHookTelemetryField(value: unknown): { text?: string; truncated: boolean } {
    if (value === undefined || value === null) {
      return { truncated: false };
    }

    const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    const max = 2_000;
    if (raw.length <= max) {
      return { text: raw, truncated: false };
    }
    return { text: `${raw.slice(0, max)}...[truncated]`, truncated: true };
  }

  private formatHookLogOutput(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }

    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
  }

  private isZodSchemaLike(value: unknown): value is ZodSchemaLike {
    return this.isRecord(value) && typeof value.safeParse === 'function';
  }

  private isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null;
  }
}
