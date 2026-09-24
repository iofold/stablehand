import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type {
  BashSpawnContext,
  BashToolOptions,
  ToolsOptions,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentHarness,
  AgentEvent as StablehandAgentEvent,
  ApprovalCallback,
  HarnessSession,
  HarnessSessionConfig,
  HarnessTurnInput,
  HarnessTurnContext,
  HarnessExportedState,
  HarnessRestorePoint,
  TokenUsage,
  ResolvedSecrets,
} from './types.js';
import type { ToolDefinition } from '../tool/types.js';
import type { Message } from '../types.js';
import { PIAgentConfigSchema, type PIAgentConfig } from './schemas.js';
import { requireCurrentTurnSecrets } from '../sandbox/turn-delivery-context.js';
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
import { filterNativeToolNames } from './native-tool-policy.js';
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

let _sdk: {
  createAgentSession: any;
  SessionManager: any;
  DefaultResourceLoader: any;
  SettingsManager: any;
  ModelRuntime: any;
  InMemoryCredentialStore: any;
  createReadTool: any;
  createBashTool: any;
  createEditTool: any;
  createWriteTool: any;
  createGrepTool: any;
  createFindTool: any;
  createLsTool: any;
  createCodingTools: any;
  Type: any;
} | null = null;

async function getSDK() {
  if (!_sdk) {
    const codingAgent = await import('@earendil-works/pi-coding-agent');
    const piAi = await import('@earendil-works/pi-ai');
    _sdk = {
      createAgentSession: codingAgent.createAgentSession,
      SessionManager: codingAgent.SessionManager,
      DefaultResourceLoader: codingAgent.DefaultResourceLoader,
      SettingsManager: codingAgent.SettingsManager,
      ModelRuntime: codingAgent.ModelRuntime,
      InMemoryCredentialStore: piAi.InMemoryCredentialStore,
      createReadTool: codingAgent.createReadTool,
      createBashTool: codingAgent.createBashTool,
      createEditTool: codingAgent.createEditTool,
      createWriteTool: codingAgent.createWriteTool,
      createGrepTool: codingAgent.createGrepTool,
      createFindTool: codingAgent.createFindTool,
      createLsTool: codingAgent.createLsTool,
      createCodingTools: codingAgent.createCodingTools,
      Type: piAi.Type,
    };
  }
  return _sdk;
}

export function zodToTypeBox(
  Type: any,
  zodSchema: z.ZodObject<any>,
): any {
  const shape = zodSchema.shape;
  const props: Record<string, any> = {};

  for (const [key, value] of Object.entries(shape)) {
    const zodVal = value as z.ZodTypeAny;
    const { schema: tbSchema } = zodFieldToTypeBox(Type, zodVal);

    const desc = zodVal.description ?? (zodVal as any)?._def?.description;
    if (desc && typeof tbSchema === 'object') {
      tbSchema.description = desc;
    }

    props[key] = tbSchema;
  }

  return Type.Object(props);
}

function zodFieldToTypeBox(
  Type: any,
  zodVal: z.ZodTypeAny | z.core.$ZodType,
): { schema: any; isOptional: boolean } {
  if (zodVal instanceof z.ZodOptional) {
    const inner = zodFieldToTypeBox(Type, zodVal.unwrap());
    return { schema: Type.Optional(inner.schema), isOptional: true };
  }

  if (zodVal instanceof z.ZodNullable) {
    const inner = zodFieldToTypeBox(Type, zodVal.unwrap());
    return { schema: inner.schema, isOptional: false };
  }

  if (zodVal instanceof z.ZodDefault) {
    const inner = zodFieldToTypeBox(Type, (zodVal as any)._def.innerType);
    return { schema: inner.schema, isOptional: true };
  }

  if (zodVal instanceof z.ZodString) {
    return { schema: Type.String(), isOptional: false };
  }
  if (zodVal instanceof z.ZodNumber) {
    return { schema: Type.Number(), isOptional: false };
  }
  if (zodVal instanceof z.ZodBoolean) {
    return { schema: Type.Boolean(), isOptional: false };
  }

  if (zodVal instanceof z.ZodEnum) {
    const raw = (zodVal as any)._def;
    const values: string[] = Array.isArray(raw.values) ? raw.values : Object.values(raw.entries ?? {});
    return { schema: Type.Union(values.map((v: string) => Type.Literal(v))), isOptional: false };
  }

  if (zodVal instanceof z.ZodArray) {
    const inner = zodFieldToTypeBox(Type, zodVal.element);
    return { schema: Type.Array(inner.schema), isOptional: false };
  }

  if (zodVal instanceof z.ZodRecord) {
    const valType = (zodVal as any)._def?.valueType;
    const inner = valType ? zodFieldToTypeBox(Type, valType) : { schema: Type.Any() };
    return { schema: Type.Record(Type.String(), inner.schema), isOptional: false };
  }

  if (zodVal instanceof z.ZodObject) {
    return { schema: zodToTypeBox(Type, zodVal), isOptional: false };
  }

  return { schema: Type.String(), isOptional: false };
}

type PIAgentToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
};

interface PIAgentExtension {
  name: string;
  wrapToolCall?(
    toolName: string,
    params: Record<string, unknown>,
    next: () => Promise<PIAgentToolResult>,
  ): Promise<PIAgentToolResult>;
  onEvent?(event: Record<string, unknown>): void;
  onSessionStart?(config: { agentId: string; conversationId: string; workspaceDir: string }): Promise<void>;
  onSessionClose?(): Promise<void>;
}

/**
 * Mutable context object shared between `convertTools` closures and `PiAgentSession`.
 * The session updates `onApprovalNeeded` and `turnId` before each turn so tool
 * `execute` callbacks always observe the current turn's approval handler without
 * requiring the entire tool list to be rebuilt.
 */
interface ConvertToolsContext {
  agentId: string;
  conversationId: string;
  workspaceDir?: string;
  onApprovalNeeded?: ApprovalCallback;
  turnId?: string;
  queuedEvents?: StablehandAgentEvent[];
}

export function convertTools(
  Type: any,
  toolDefs: ToolDefinition[],
  config: ConvertToolsContext,
  extensions: PIAgentExtension[] = [],
): any[] {
  return toolDefs.map((def) => ({
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: zodToTypeBox(Type, def.input as z.ZodObject<any>),
    execute: async (
      toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
    ) => {
      if (def.requiresApproval && config.onApprovalNeeded) {
        const approval = await requestToolApproval({
          id: toolCallId,
          turnId: config.turnId ?? config.conversationId,
          toolName: def.name,
          args: params,
          onApprovalNeeded: config.onApprovalNeeded,
          emit: (event) => config.queuedEvents?.push(event),
        });
        if (!approval.approved) {
          return {
            content: [{ type: 'text' as const, text: approval.rejectionMessage }],
            details: {},
          };
        }
      }

      const baseHandler = async (): Promise<PIAgentToolResult> => {
        const result = await def.handler(params, {
          agentId: config.agentId,
          conversationId: config.conversationId,
          workspaceDir: config.workspaceDir || process.cwd(),
          eventBus: undefined,
        });

        return {
          content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }],
          details: {},
        };
      };

      let chain: () => Promise<PIAgentToolResult> = baseHandler;
      for (let i = extensions.length - 1; i >= 0; i--) {
        const ext = extensions[i];
        if (ext.wrapToolCall) {
          const prev = chain;
          chain = () => ext.wrapToolCall!(def.name, params, prev);
        }
      }

      try {
        return await chain();
      } catch (handlerErr) {
        const msg = errorMessage(handlerErr);
        return {
          content: [{ type: 'text' as const, text: `Tool "${def.name}" execution failed: ${msg}` }],
          details: {},
        };
      }
    },
  }));
}

function resolveModel(
  getModelFn: any,
  harnessConfig: PIAgentConfig,
  secrets: ResolvedSecrets,
): {
  model: any;
  pricingKnown: boolean;
  connection: HarnessModelConnection;
} {
  const {
    provider,
    model,
    baseUrl,
    apiKeyRef,
    maxTokens,
    reasoning,
  } = harnessConfig;
  const connection = resolveHarnessModelConnection({
    provider,
    apiKeyRef,
    baseUrl,
    secrets,
  });
  const resolved = getModelFn(provider, model);
  const gatewayBaseUrl = connection.mode === 'gateway' && provider === 'google'
    ? `${connection.baseUrl.replace(/\/+$/, '')}/v1beta`
    : connection.baseUrl;
  if (resolved) {
    const needsModelOverride = gatewayBaseUrl !== undefined
      || maxTokens !== undefined
      || reasoning !== undefined;
    return {
      connection,
      pricingKnown: connection.mode === 'direct',
      model: needsModelOverride
        ? {
          ...resolved,
          provider,
          id: model,
          ...(gatewayBaseUrl
            ? { baseUrl: gatewayBaseUrl, apiKey: connection.apiKey }
            : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(reasoning !== undefined ? { reasoning } : {}),
        }
        : resolved,
    };
  }

  const providerDefaults: Record<string, { baseUrl: string; api: string }> = {
    openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
    anthropic: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
    google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
  };
  const defaults = providerDefaults[provider] ?? providerDefaults.openai;

  return {
    connection,
    pricingKnown: false,
    model: {
      id: model,
      name: model,
      provider,
      api: defaults.api,
      baseUrl: gatewayBaseUrl ?? defaults.baseUrl,
      apiKey: connection.apiKey,
      reasoning: reasoning ?? false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: maxTokens ?? 16384,
    },
  };
}

export function _piUpdateUsage(
  totalUsage: TokenUsage | undefined,
  piEvent: Record<string, unknown>,
  pricingKnown: boolean,
): TokenUsage | undefined {
  if (piEvent.type !== 'turn_end') {
    return totalUsage;
  }

  const usage = (piEvent.message as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) {
    return totalUsage;
  }

  const normalized = normalizeTokenUsage(usage);
  if (!normalized) {
    return totalUsage;
  }

  const nextUsage: TokenUsage = totalUsage ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  nextUsage.inputTokens += normalized.inputTokens;
  nextUsage.outputTokens += normalized.outputTokens;
  nextUsage.totalTokens += normalized.totalTokens;
  if (pricingKnown && normalized.costUsd !== undefined) {
    nextUsage.costUsd = (nextUsage.costUsd ?? 0) + normalized.costUsd;
  }

  return nextUsage;
}

export function _piMapAgentEvent(
  piEvent: Record<string, unknown>,
  usage: TokenUsage | undefined,
): StablehandAgentEvent | null {
  switch (piEvent.type) {
    case 'message_update': {
      const streamEvent = piEvent.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (streamEvent?.type === 'text_delta' && streamEvent.delta) {
        return { type: 'text_delta', content: streamEvent.delta };
      }
      return null;
    }

    case 'tool_execution_start': {
      return {
        type: 'tool_call_start',
        id: typeof piEvent.toolCallId === 'string' ? piEvent.toolCallId : randomUUID(),
        name: typeof piEvent.toolName === 'string' ? piEvent.toolName : 'unknown',
        args: piEvent.args ?? {},
      };
    }

    case 'tool_execution_end': {
      const result = piEvent.result as { content?: unknown } | undefined;
      let resultText = '';

      if (Array.isArray(result?.content)) {
        resultText = result.content
          .filter((item) => typeof item === 'object' && item !== null && (item as { type?: string }).type === 'text')
          .map((item) => (item as { text?: string }).text ?? '')
          .join('');
      } else if (typeof result?.content === 'string') {
        resultText = result.content;
      } else if (piEvent.result != null) {
        resultText = JSON.stringify(piEvent.result);
      }

      return {
        type: 'tool_call_end',
        id: typeof piEvent.toolCallId === 'string' ? piEvent.toolCallId : randomUUID(),
        result: resultText,
        error: piEvent.isError ? resultText : undefined,
        durationMs: 0,
      };
    }

    case 'agent_end': {
      return {
        type: 'done',
        ...(usage ? { usage } : {}),
      };
    }

    default:
      return null;
  }
}

type NativePiSession = {
  subscribe: (listener: (event: Record<string, unknown>) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  state: {
    messages: Array<Record<string, unknown>>;
  };
  setModel: (model: Record<string, unknown>) => Promise<void> | void;
};

export class PIAgentHarness implements AgentHarness {
  readonly name = 'pi-agent';
  readonly configSchema = PIAgentConfigSchema;
  readonly enforcementCapabilities = {
    observationBoundary: 'before_and_after',
    activeCallCancellation: true,
    softStop: false,
  } as const;

  async openSession(config: HarnessSessionConfig, restore?: HarnessRestorePoint): Promise<HarnessSession> {
    const sdk = await getSDK();
    const cwd = config.workspaceDir ?? process.cwd();
    const harnessConfig = parseHarnessConfig(PIAgentConfigSchema, config.harnessConfigJson);
    const extensions: PIAgentExtension[] = [];
    const workspaceDir = config.workspaceDir ?? process.cwd();
    for (const extPath of (harnessConfig.extensions ?? [])) {
      try {
        const resolved = path.resolve(workspaceDir, extPath);
        const mod = await import(resolved);
        const ext = mod.default ?? mod;
        const loaded: PIAgentExtension = typeof ext === 'function' ? ext() : ext;
        if (loaded.name) {
          extensions.push(loaded);
          console.error(`[pi-agent] Loaded extension: ${loaded.name} from ${extPath}`);
        } else {
          console.error(`[pi-agent] Extension missing 'name' property: ${extPath}`);
        }
      } catch (err) {
        console.error(`[pi-agent] Failed to load extension: ${extPath}`, err);
      }
    }
    const credentialStore = new sdk.InMemoryCredentialStore();
    const modelRuntime = await sdk.ModelRuntime.create({
      credentials: credentialStore,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const { model, pricingKnown, connection } = resolveModel(
      modelRuntime.getModel.bind(modelRuntime),
      harnessConfig,
      config.secrets,
    );

    const nativeTools = this.buildNativeTools(config, {
      createReadTool: sdk.createReadTool,
      createBashTool: sdk.createBashTool,
      createEditTool: sdk.createEditTool,
      createWriteTool: sdk.createWriteTool,
      createGrepTool: sdk.createGrepTool,
      createFindTool: sdk.createFindTool,
      createLsTool: sdk.createLsTool,
      createCodingTools: sdk.createCodingTools,
    });

    const turnRef: ConvertToolsContext = {
      agentId: config.agentId,
      conversationId: config.conversationId,
      workspaceDir: config.workspaceDir,
      onApprovalNeeded: config.onApprovalNeeded,
      turnId: config.conversationId,
    };
    const customTools = convertTools(sdk.Type, config.tools, turnRef, extensions);

    if (connection.apiKey) {
      await modelRuntime.setRuntimeApiKey(
        harnessConfig.provider,
        connection.apiKey,
        { allowNetwork: false },
      );
    }
    const settingsManager = sdk.SettingsManager.inMemory();
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      systemPromptOverride: () => config.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const created = await sdk.createAgentSession({
      cwd,
      model,
      modelRuntime,
      ...(harnessConfig.thinkingLevel
        ? { thinkingLevel: harnessConfig.thinkingLevel }
        : {}),
      noTools: 'builtin',
      customTools: [...nativeTools, ...customTools] as any[],
      sessionManager: restore
        ? sdk.SessionManager.continueRecent(cwd)
        : sdk.SessionManager.create(cwd),
      settingsManager,
      resourceLoader,
    });
    const nativeSession: NativePiSession = created.session;

    const session = new PiAgentSession(
      nativeSession,
      config,
      turnRef,
      extensions,
      pricingKnown,
      model,
      connection.mode === 'gateway',
    );
    for (const ext of extensions) {
      try {
        await ext.onSessionStart?.({
          agentId: config.agentId,
          conversationId: config.conversationId,
          workspaceDir: config.workspaceDir ?? process.cwd(),
        });
      } catch (err) {
        console.error(`[pi-agent] Extension '${ext.name}' onSessionStart error:`, err);
      }
    }
    if (restore) {
      const restoredTranscript = restore.payload['transcript'];
      if (Array.isArray(restoredTranscript) && restoredTranscript.length > 0) {
        session.restoreTranscript(restoredTranscript as Message[]);
      }
    }

    return withTurnTracing(session, config, this.name);
  }

  private buildNativeTools(
    config: HarnessSessionConfig,
    factories: {
      createReadTool: (cwd: string) => unknown;
      createBashTool: (cwd: string, options?: BashToolOptions) => unknown;
      createEditTool: (cwd: string) => unknown;
      createWriteTool: (cwd: string) => unknown;
      createGrepTool: (cwd: string) => unknown;
      createFindTool: (cwd: string) => unknown;
      createLsTool: (cwd: string) => unknown;
      createCodingTools: (cwd: string, options?: ToolsOptions) => unknown[];
    },
  ): unknown[] {
    const cwd = config.workspaceDir ?? process.cwd();
    const bashOptions: BashToolOptions = {
      spawnHook: (context: BashSpawnContext): BashSpawnContext => ({
        ...context,
        env: {
          ...context.env,
          ...requireCurrentTurnSecrets(),
        },
      }),
    };
    const allFactories: Record<string, () => unknown> = {
      read: () => factories.createReadTool(cwd),
      bash: () => factories.createBashTool(cwd, bashOptions),
      edit: () => factories.createEditTool(cwd),
      write: () => factories.createWriteTool(cwd),
      grep: () => factories.createGrepTool(cwd),
      find: () => factories.createFindTool(cwd),
      ls: () => factories.createLsTool(cwd),
    };

    const nativeToolPolicy = config.nativeToolPolicy;
    if (!nativeToolPolicy || nativeToolPolicy.policy === 'all') {
      return factories.createCodingTools(cwd, { bash: bashOptions });
    }
    const names = filterNativeToolNames(Object.keys(allFactories), nativeToolPolicy);
    return names.filter((n) => n in allFactories).map((n) => allFactories[n]());
  }

}

class PiAgentSession implements HarnessSession {
  private transcript: Message[] = [];

  constructor(
    private readonly nativeSession: NativePiSession,
    private readonly config: HarnessSessionConfig,
    private readonly turnRef: ConvertToolsContext,
    private readonly extensions: PIAgentExtension[],
    private readonly pricingKnown: boolean,
    private readonly model: Record<string, unknown>,
    private readonly gatewayEnabled: boolean,
  ) {}

  restoreTranscript(messages: Message[]): void {
    this.transcript.push(...messages);
  }

  /**
   * Project the canonical transcript into the PI SDK's native history with
   * roles preserved (ctx-j46h): user/assistant/toolResult map one-to-one.
   * Mid-transcript system notices keep the bracketed-user fallback because
   * PI history has no system role — the session system prompt itself is
   * wired through the resource loader. Tool pairs are only emitted when both
   * sides exist; strict providers reject unpaired toolCall/toolResult rows.
   */
  private buildNativeHistoryMessages(messages: Message[]): Array<Record<string, unknown>> {
    const resultToolCallIds = new Set(
      messages
        .filter((message) => message.role === 'tool' && message.toolCallId)
        .map((message) => message.toolCallId as string),
    );
    const modelApi = typeof this.model.api === 'string' ? this.model.api : 'openai-completions';
    const modelProvider = typeof this.model.provider === 'string' ? this.model.provider : 'openai';
    const modelId = typeof this.model.id === 'string' ? this.model.id : 'unknown';
    const zeroUsage = () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    const emittedToolCalls = new Map<string, string>();
    const native: Array<Record<string, unknown>> = [];
    for (const [index, message] of messages.entries()) {
      const timestamp = this.toNativeTimestamp(message.createdAt, index);
      switch (message.role) {
        case 'user':
          native.push({ role: 'user', content: message.content, timestamp });
          break;
        case 'assistant': {
          const content: Array<Record<string, unknown>> = [];
          if (message.content) {
            content.push({ type: 'text', text: message.content });
          }
          const pairedToolCalls = (message.toolCalls ?? [])
            .filter((toolCall) => resultToolCallIds.has(toolCall.id));
          for (const toolCall of pairedToolCalls) {
            emittedToolCalls.set(toolCall.id, toolCall.name);
            content.push({
              type: 'toolCall',
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments ?? {},
            });
          }
          if (content.length === 0) {
            break;
          }
          native.push({
            role: 'assistant',
            content,
            api: modelApi,
            provider: modelProvider,
            model: modelId,
            usage: zeroUsage(),
            stopReason: pairedToolCalls.length > 0 ? 'toolUse' : 'stop',
            timestamp,
          });
          break;
        }
        case 'tool': {
          const toolName = message.toolCallId
            ? emittedToolCalls.get(message.toolCallId)
            : undefined;
          if (!message.toolCallId || !toolName) {
            native.push({
              role: 'user',
              content: this.formatTranscriptMessage(message),
              timestamp,
            });
            break;
          }
          native.push({
            role: 'toolResult',
            toolCallId: message.toolCallId,
            toolName,
            content: [{ type: 'text', text: message.content }],
            isError: false,
            timestamp,
          });
          break;
        }
        case 'system':
        default:
          native.push({
            role: 'user',
            content: this.formatTranscriptMessage(message),
            timestamp,
          });
          break;
      }
    }
    return native;
  }

  private formatTranscriptMessage(message: Message): string {
    switch (message.role) {
      case 'assistant':
        return `[Previous assistant response]\n${message.content}`;
      case 'system':
        return `[Previous system message]\n${message.content}`;
      case 'tool':
        return `[Previous tool result${message.toolCallId ? ` (${message.toolCallId})` : ''}]\n${message.content}`;
      case 'user':
      default:
        return message.content;
    }
  }

  private toNativeTimestamp(createdAt: Date, index: number): number {
    const base = createdAt instanceof Date ? createdAt.getTime() : Date.now();
    return base + index;
  }

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<StablehandAgentEvent> {
    this.transcript = [...input.messages];
    this.turnRef.onApprovalNeeded = context.onApprovalNeeded ?? this.config.onApprovalNeeded;
    this.turnRef.turnId = input.turnId;

    const latestMessage = input.messages[input.messages.length - 1];
    const lastUserMsg = latestMessage?.role === 'user' ? latestMessage : undefined;
    const nativeHistory = lastUserMsg
      ? input.messages.slice(0, -1)
      : input.messages;

    const eventQueue: StablehandAgentEvent[] = [];
    let done = false;
    let totalUsage: TokenUsage | undefined;
    let unsubscribe: (() => void) | undefined;
    let aborted = false;
    let modelError: string | undefined;
    let unlinkAbort: () => void = () => {};
    const accumulator = new TurnAccumulator({ turnId: input.turnId });

    try {
      this.turnRef.queuedEvents = eventQueue;
      const abortNativeSession = () => {
        aborted = true;
        void Promise.resolve(this.nativeSession.abort()).catch((err) => {
          console.error('[pi-agent] abort failed:', err);
        });
      };
      const enforcer = this.config.turnEnforcer;
      // pi has no soft-stop channel, so every tripped cap cancels the turn.
      // The decision arrives on a floating promise because the SDK event
      // callback is synchronous; abort is idempotent, so the one-event race
      // is harmless.
      const applyFanoutDecision = (decision: ModelCallDecision) => {
        if (decision.action === 'continue') return;
        if (enforcer instanceof FanoutLimitHarnessTurnEnforcer
          && enforcer.takeFirstTrip(decision.reason)) {
          eventQueue.push({
            type: 'custom_agui_event',
            event: fanoutTelemetryEvent('pi-agent', decision.reason, decision.action, enforcer.snapshot()),
          });
          eventQueue.push({ type: 'error', error: fanoutLimitMessage(decision.reason, enforcer.limits) });
        }
        abortNativeSession();
      };
      const modelId = typeof this.model.id === 'string' ? this.model.id : '';
      const providerId = typeof this.model.provider === 'string' ? this.model.provider : 'pi';
      unsubscribe = this.nativeSession.subscribe((piEvent: Record<string, unknown>) => {
        const eventType = typeof piEvent.type === 'string' ? piEvent.type : 'unknown';
        const eventKeys = Object.keys(piEvent).filter((k) => k !== 'type').join(',');
        console.log(`[pi-agent] SDK event: ${eventType} keys=[${eventKeys}]`);
        if (eventType === 'message_end' || eventType === 'turn_end' || eventType === 'message_start') {
          console.log(`[pi-agent] SDK event payload: ${JSON.stringify(piEvent).slice(0, 500)}`);
        }
        for (const ext of this.extensions) {
          try {
            ext.onEvent?.(piEvent);
          } catch (err) {
            console.error(`[pi-agent] Extension '${ext.name}' onEvent error:`, err);
          }
        }
        if (piEvent.type === 'message_end' || piEvent.type === 'turn_end') {
          const msg = piEvent.message as Record<string, unknown> | undefined;
          if (msg?.stopReason === 'error') {
            console.error(`[pi-agent] SDK model error: ${msg.errorMessage}`);
            if (piEvent.type === 'turn_end') {
              modelError = typeof msg.errorMessage === 'string' && msg.errorMessage.length > 0
                ? msg.errorMessage
                : 'PI model request failed';
            }
          }
        }
        if (piEvent.type === 'turn_start' && enforcer && !aborted) {
          void enforcer.beforeModelCall({ turnId: input.turnId, provider: providerId, model: modelId })
            .then(applyFanoutDecision)
            .catch((err) => console.error('[pi-agent] fanout enforcement error:', err));
        }
        totalUsage = _piUpdateUsage(
          totalUsage,
          piEvent,
          this.pricingKnown,
        );
        const mapped = _piMapAgentEvent(piEvent, totalUsage);
        if (mapped) {
          if (mapped.type === 'text_delta') {
            eventQueue.push(accumulator.appendText(mapped.content));
          } else if (mapped.type === 'done') {
            if (!aborted && !modelError) {
              accumulator.recordDone({
                ...mapped,
                ...(mapped.usage ? { usage: mapped.usage } : {}),
              });
            }
          } else {
            if (mapped.type === 'tool_call_start') {
              if (enforcer?.onToolBoundary && !aborted) {
                void enforcer.onToolBoundary({ turnId: input.turnId, toolName: mapped.name })
                  .then(applyFanoutDecision)
                  .catch((err) => console.error('[pi-agent] fanout enforcement error:', err));
              }
              accumulator.recordToolStart({
                id: mapped.id,
                name: mapped.name,
                args: mapped.args,
              });
            } else if (mapped.type === 'tool_call_end' && mapped.error) {
              accumulator.recordToolEnd({ id: mapped.id, result: mapped.result, error: mapped.error });
            } else if (mapped.type === 'tool_call_end') {
              accumulator.recordToolEnd({ id: mapped.id, result: mapped.result });
            }
            eventQueue.push(mapped);
          }
        }
        if (piEvent.type === 'agent_end') {
          if (!aborted && modelError) {
            eventQueue.push({ type: 'error', error: modelError });
          }
          done = true;
        }
      });

      unlinkAbort = linkTurnAbort(this.config.signal, context.signal, abortNativeSession);

      if (!lastUserMsg) {
        done = true;
        accumulator.recordDone({
          type: 'done',
          ...(totalUsage ? { usage: totalUsage } : {}),
        });
      }

      this.nativeSession.state.messages = this.buildNativeHistoryMessages(
        nativeHistory,
      );
      if (this.gatewayEnabled) {
        await this.nativeSession.setModel({
          ...this.model,
          headers: {
            ...(typeof this.model.headers === 'object' && this.model.headers !== null
              ? this.model.headers as Record<string, string>
              : {}),
            ...createGatewayCorrelationHeaders(input.turnId),
          },
        });
      }

      const promptPromise = lastUserMsg
        ? this.nativeSession.prompt(lastUserMsg.content)
        : Promise.resolve();

      promptPromise.catch((err: unknown) => {
        eventQueue.push({ type: 'error', error: String(err) });
        done = true;
      });

      while (!done || eventQueue.length > 0) {
        if (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      }

      yield* finalizeTurn(
        accumulator,
        this.transcript,
        this.config.agentId ?? this.config.conversationId,
      );

      await promptPromise;
    } catch (err) {
      console.error('[pi-agent] deliverTurn error:', err);
      yield { type: 'error', error: String(err) };
    } finally {
      unlinkAbort();
      this.turnRef.queuedEvents = undefined;
      unsubscribe?.();
    }
  }

  async exportState(): Promise<HarnessExportedState> {
    return {
      stateVersion: '2',
      payload: {
        transcript: this.transcript,
        nativePersistence: true,
      },
    };
  }

  async close(): Promise<void> {
    try {
      for (const ext of this.extensions) {
        try {
          await ext.onSessionClose?.();
        } catch (err) {
          console.error(`[pi-agent] Extension '${ext.name}' onSessionClose error:`, err);
        }
      }
    } finally {
      this.nativeSession.dispose();
    }
  }
}
