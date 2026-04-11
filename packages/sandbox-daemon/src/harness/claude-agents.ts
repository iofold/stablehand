import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { query as sdkQuery, createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
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
  createStubKnowledgeContext,
  normalizeStreamTextDeltas,
  resolveSecretRef,
} from './shared.js';

const ClaudeAgentDefinitionSchema = z.object({
  description: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
});

export const ClaudeAgentsConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().min(1),
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().refine((value) => URL.canParse(value)).optional(),
  maxTurns: z.number().int().positive().optional(),
  setup: z.object({
    symlinks: z.array(z.object({
      src: z.string(),
      dest: z.string(),
    })).optional(),
  }).optional(),
  subagents: z.record(z.string(), ClaudeAgentDefinitionSchema).optional(),
});

export type ClaudeAgentsConfig = z.infer<typeof ClaudeAgentsConfigSchema>;

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
  toolUseId?: string;
  content?: unknown;
  is_error?: boolean;
  isError?: boolean;
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
};

class ClaudeSession implements HarnessSession {
  private transcript: Message[] = [];
  private readonly queuedEvents: AgentEvent[] = [];
  private activeApprovalHandler: ApprovalCallback | undefined;
  private readonly mcpServer: ReturnType<typeof createSdkMcpServer>;
  private restoredFromCheckpoint = false;

  constructor(
    private readonly config: HarnessSessionConfig,
    private readonly harnessConfig: ClaudeAgentsConfig,
    private readonly apiKey: string,
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
    this.mcpServer = sdk.createSdkMcpServer({ name: 'ctxmill', tools: mcpTools });
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
      ?? path.join(process.env.HOME ?? '/home/ctxmill', '.claude');
    const workspaceDir = this.config.workspaceDir || '/workspace';
    const sessionId = this.config.conversationId;
    const sanitizedWorkspaceDir = workspaceDir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200);
    const hashedWorkspaceDir = createHash('sha256').update(workspaceDir).digest('hex');
    const projectDirs = [...new Set([sanitizedWorkspaceDir, hashedWorkspaceDir])];

    return projectDirs.map((projectDir) =>
      path.join(configDir, 'projects', projectDir, 'sessions', `${sessionId}.jsonl`),
    );
  }

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent> {
    const isFirstTurn = this.restoredFromCheckpoint || this.transcript.length === 0;
    this.transcript = [...input.messages];
    this.activeApprovalHandler = context.onApprovalNeeded ?? this.config.onApprovalNeeded;

    const abortController = new AbortController();
    const cleanupAbort = this.linkAbortSignals(
      [this.config.signal, context.signal],
      abortController,
    );
    const toolStartTimes = new Map<string, number>();
    const streamState = this.harness.createStreamMappingState();
    let assistantText = '';
    let doneEvent: Extract<AgentEvent, { type: 'done' }> | undefined;
    const accumulatedToolCalls: Array<
      NonNullable<Message['toolCalls']>[number] & { args: string; status: 'complete' | 'error' }
    > = [];

    try {
      const maxTurns = this.harnessConfig.maxTurns;
      const sdkSessionId = this.config.conversationId;

      const q = this.sdk.query({
        prompt: this.generateInput(input.messages),
        options: {
          model: this.harnessConfig.model,
          systemPrompt: this.config.systemPrompt,
          cwd: this.config.workspaceDir,
          settingSources: ['project'],
          allowedTools: this.buildAllowedTools() ?? [],
          disallowedTools: this.buildDisallowedTools() ?? [],
          mcpServers: { ctxmill: this.mcpServer },
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          includePartialMessages: false,
          persistSession: true,
          ...(this.buildAgents() ? { agents: this.buildAgents() } : {}),
          ...(isFirstTurn ? { sessionId: sdkSessionId } : { resume: sdkSessionId }),
          abortController,
          env: this.buildClaudeEnv(),
          ...(maxTurns != null ? { maxTurns } : {}),
        },
      } as Parameters<typeof sdkQuery>[0]);

      for await (const message of q) {
        yield* this.flushQueuedEvents();
        for (const event of this.harness.mapSDKMessage(message, toolStartTimes, streamState)) {
          if (event.type === 'text_delta' && typeof event.content === 'string') {
            assistantText += event.content;
          }

          if (event.type === 'tool_call_start') {
            accumulatedToolCalls.push({
              id: event.id,
              name: event.name,
              arguments: typeof event.args === 'object' && event.args !== null && !Array.isArray(event.args)
                ? Object.fromEntries(Object.entries(event.args as Record<string, unknown>))
                : {},
              args: typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? {}),
              status: 'complete',
            });
          } else if (event.type === 'tool_call_end' && event.error) {
            const existing = accumulatedToolCalls.find((tc) => tc.id === event.id);
            if (existing) existing.status = 'error';
          }

          if (event.type === 'done') {
            doneEvent = event;
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
      const committedToolCalls: Message['toolCalls'] | undefined =
        accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined;
      if (assistantText.length > 0 || accumulatedToolCalls.length > 0) {
        this.transcript.push({
          id: randomUUID(),
          agentId: this.config.agentId ?? this.config.conversationId,
          role: 'assistant',
          content: assistantText,
          ...(committedToolCalls ? { toolCalls: committedToolCalls } : {}),
          createdAt: new Date(),
        });

        yield {
          type: 'message_committed',
          role: 'assistant',
          content: assistantText,
          ...(committedToolCalls ? { toolCalls: committedToolCalls } : {}),
          turnId: input.turnId,
          messageSeq: this.transcript.length - 1,
        };
      }

      if (doneEvent) {
        yield doneEvent;
      }
    } catch (error) {
      console.error('[claude-agents] deliverTurn error:', error);
      yield* this.flushQueuedEvents();
      yield { type: 'error', error: this.stringifyError(error) };
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
        sessionId: this.config.conversationId,
        ...(sessionJSONL != null ? { sessionJSONL } : {}),
      },
    };
  }

  async close(): Promise<void> {}

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

  private async *generateInput(messages: Message[]): AsyncGenerator<SdkPromptMessage> {
    if (this.restoredFromCheckpoint && messages.length > 1) {
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
        return `[Previous assistant response]\n${message.content}`;
      case 'system':
        return `[Previous system message]\n${message.content}`;
      case 'tool':
        return `[Previous tool output]\n${message.content}`;
      case 'user':
      default:
        return message.content;
    }
  }

  private buildAllowedTools(): string[] | undefined {
    const nativeTools = this.config.nativeTools;
    const merged: string[] = [];

    for (const nt of nativeTools ?? []) {
      if (nt.allowlist) {
        merged.push(...nt.allowlist);
      }
    }

    if (this.harnessConfig.subagents) {
      merged.push('Agent');
    }

    return merged.length ? [...new Set([...merged, 'mcp__ctxmill__*'])] : undefined;
  }

  private buildDisallowedTools(): string[] | undefined {
    const nativeTools = this.config.nativeTools;
    if (!nativeTools?.length) return undefined;
    const merged: string[] = [];
    for (const nt of nativeTools) {
      if (nt.blocklist) merged.push(...nt.blocklist);
    }
    return merged.length ? merged : undefined;
  }

  private buildClaudeEnv(): Record<string, string> {
    const claudeEnv: Record<string, string> = {
      HOME: process.env.HOME ?? '/home/ctxmill',
      PATH:
        process.env.PATH ??
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ANTHROPIC_API_KEY: this.apiKey,
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      ...(this.harnessConfig.baseUrl
        ? { ANTHROPIC_BASE_URL: this.harnessConfig.baseUrl }
        : {}),
    };
    // Copy remaining env vars, but exclude model-related keys that could
    // override the explicit model option passed to the SDK.
    const MODEL_ENV_BLOCKLIST: ReadonlySet<string> = new Set([
      'OPENAI_MODEL',
      'ANTHROPIC_MODEL',
      'MODEL',
      'CLAUDE_MODEL',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !(k in claudeEnv) && !MODEL_ENV_BLOCKLIST.has(k)) claudeEnv[k] = v;
    }
    return claudeEnv;
  }

  private buildAgents(): Record<string, AgentDefinition> | undefined {
    return this.harnessConfig.subagents;
  }

  private linkAbortSignals(
    signals: (AbortSignal | undefined)[],
    abortController: AbortController,
  ): () => void {
    const cleanups: (() => void)[] = [];
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) {
        abortController.abort();
        return () => undefined;
      }
      const onAbort = () => abortController.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
    return () => { for (const c of cleanups) c(); };
  }

  private stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export class ClaudeAgentsHarness implements AgentHarness {
  readonly name = 'claude-agents';
  readonly configSchema = ClaudeAgentsConfigSchema;

  protected async loadSdkModule(): Promise<ClaudeSdkModule> {
    const baseSdk: ClaudeSdkModule = {
      query: sdkQuery,
      tool: sdkTool as unknown as SdkToolFactory,
      createSdkMcpServer,
    };

    if (process.env.LANGSMITH_TRACING !== 'true') {
      return baseSdk;
    }

    try {
      const { wrapClaudeAgentSDK } = await import('langsmith/experimental/anthropic');
      const wrapped = wrapClaudeAgentSDK(baseSdk);
      console.log('[claude-agents] LangSmith tracing enabled');
      return {
        query: wrapped.query ?? baseSdk.query,
        tool: (wrapped.tool ?? baseSdk.tool) as unknown as SdkToolFactory,
        createSdkMcpServer: wrapped.createSdkMcpServer ?? baseSdk.createSdkMcpServer,
      };
    } catch (err) {
      console.warn('[claude-agents] LangSmith tracing init failed, continuing without:', err);
      return baseSdk;
    }
  }

  async openSession(
    config: HarnessSessionConfig,
    restore?: HarnessRestorePoint,
  ): Promise<HarnessSession> {
    const sdk = await this.loadSdkModule();
    const harnessConfig = ClaudeAgentsConfigSchema.parse(
      JSON.parse(z.string().parse(config.harnessConfigJson)),
    );
    const apiKey =
      resolveSecretRef(harnessConfig.apiKeyRef, config.secrets) ??
      process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error('Missing Anthropic API key for claude-agents harness.');
    }

    const session = new ClaudeSession(config, harnessConfig, apiKey, this, sdk);
    if (restore) {
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
    return session;
  }

  async convertTools(
    toolDefs: ToolDefinition[],
    runId: string,
    config?: HarnessSessionConfig,
    onApprovalNeeded?: ApprovalCallback,
  ): Promise<ConvertedMcpTool[]> {
    return this.convertToolsWithSDK(
      { tool: sdkTool as unknown as SdkToolFactory },
      toolDefs,
      runId,
      config,
      onApprovalNeeded,
    );
  }

  convertToolsWithSDK(
    sdk: { tool: SdkToolFactory },
    toolDefs: ToolDefinition[],
    runId: string,
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
            queuedEvents?.push({
              type: 'approval_needed',
              id: approvalId,
              tool: definition.name,
              args,
            });

            const approvalRequest: ApprovalRequest = {
              id: approvalId,
              runId,
              toolName: definition.name,
              args,
            };
            const approvalResponse = await onApprovalNeeded(approvalRequest);

            queuedEvents?.push({
              type: 'approval_resolved',
              id: approvalId,
              action: approvalResponse.action,
            });

            if (approvalResponse.action !== 'approve') {
              return {
                content: [{ type: 'text', text: 'Tool call was rejected by the user.' }],
                isError: true,
              };
            }
          }

          try {
            const result = await definition.handler(
              args,
              this.createToolContext(config, runId),
            );

            return {
              content: [{ type: 'text', text: this.stringifyResult(result) }],
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: this.stringifyError(error) }],
              isError: true,
            };
          }
        },
      ) as ConvertedMcpTool;
    });
  }

  buildCanUseTool(
    toolDefs: ToolDefinition[],
    onApprovalNeeded: ApprovalCallback | undefined,
    runId: string,
  ) {
    const approvalSet = new Set(
      toolDefs
        .filter((toolDefinition) => toolDefinition.requiresApproval)
        .map((toolDefinition) => toolDefinition.name),
    );

    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID: string },
    ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> => {
      if (options.signal.aborted || !approvalSet.has(toolName) || !onApprovalNeeded) {
        return { behavior: 'allow' };
      }

      const approvalRequest: ApprovalRequest = {
        id: options.toolUseID || randomUUID(),
        runId,
        toolName,
        args: input,
      };
      const response = await onApprovalNeeded(approvalRequest);
      if (response.action === 'approve') {
        return { behavior: 'allow' };
      }

      return { behavior: 'deny', message: 'Tool call was rejected by the user.' };
    };
  }

  createStreamMappingState(): StreamMappingState {
    return {
      sawTextDeltaSinceAssistant: false,
      toolCallIdsByIndex: new Map<number, string>(),
      toolArgsJsonByCallId: new Map<string, string>(),
    };
  }

  *mapSDKMessage(
    message: SDKMessage,
    toolStartTimes: Map<string, number>,
    streamState: StreamMappingState = this.createStreamMappingState(),
  ): Generator<AgentEvent> {
    switch (message.type) {
      case 'system': {
        if (this.isSystemInitMessage(message)) {
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

        if (!streamState.sawTextDeltaSinceAssistant) {
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

          yield {
            type: 'tool_call_start',
            id: callId,
            name: toolUseBlock.name ?? 'unknown',
            args: toolUseBlock.input ?? this.readBufferedToolArgs(streamState, callId) ?? {},
          };
        }

        streamState.sawTextDeltaSinceAssistant = false;
        break;
      }

      case 'user': {
        const resultBlocks = this.extractToolResultBlocks(message);
        for (const toolResultBlock of resultBlocks) {
          const callId = toolResultBlock.tool_use_id ?? toolResultBlock.toolUseId ?? message.parent_tool_use_id ?? randomUUID();
          const startedAt = toolStartTimes.get(callId) ?? Date.now();
          const durationMs = Date.now() - startedAt;
          toolStartTimes.delete(callId);

          const result = this.stringifyToolResultContent(toolResultBlock.content);
          const error = toolResultBlock.is_error || toolResultBlock.isError
            ? (result || 'Tool call was rejected by the user.')
            : undefined;

          yield {
            type: 'tool_call_end',
            id: callId,
            result,
            ...(error ? { error } : {}),
            durationMs,
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
    runId: string,
  ): ToolContext {
    return {
      agentId: config?.agentId ?? '',
      conversationId: config?.conversationId ?? runId,
      workspaceDir: config?.workspaceDir ?? process.cwd(),
      knowledge: createStubKnowledgeContext(),
    };
  }

  private extractUsage(message: SDKResultMessage): TokenUsage | undefined {
    const usage = message.usage;
    if (!usage) {
      return undefined;
    }

    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    const cost = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined;

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      ...(cost != null ? { cost } : {}),
    };
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
          : typeof value.toolUseId === 'string'
            ? value.toolUseId
            : parentToolUseId ?? undefined;

      if (
        toolUseId ||
        'content' in value ||
        'is_error' in value ||
        'isError' in value
      ) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: value.content ?? value,
          is_error: value.is_error === true || value.isError === true,
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
    } catch {
      console.error(`[claude-agents] Failed to parse tool args for call ${callId}, returning empty object. Raw: ${raw.slice(0, 200)}`);
      return {};
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

  private stringifyError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

  private isSystemInitMessage(value: SDKSystemMessage): boolean {
    return value.subtype === 'init';
  }

  private isZodSchemaLike(value: unknown): value is ZodSchemaLike {
    return this.isRecord(value) && typeof value.safeParse === 'function';
  }

  private isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null;
  }
}
