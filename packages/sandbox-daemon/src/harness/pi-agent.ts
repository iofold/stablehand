import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type {
  AgentHarness,
  AgentEvent as CtxMillAgentEvent,
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
import { CanonicalProviderSchema } from './shared.js';
import {
  TurnAccumulator,
  createAgentEventLangSmithTracer,
  linkAbortSignal,
  normalizeTokenUsage,
  requestToolApproval,
  resolveModelAuth,
  traceAgentEvents,
} from './kit/index.js';

let _sdk: {
  createAgentSession: any;
  SessionManager: any;
  DefaultResourceLoader: any;
  SettingsManager: any;
  AuthStorage: any;
  ModelRegistry: any;
  createReadTool: any;
  createBashTool: any;
  createEditTool: any;
  createWriteTool: any;
  createGrepTool: any;
  createFindTool: any;
  createLsTool: any;
  createCodingTools: any;
  Type: any;
  getModel: any;
} | null = null;

async function getSDK() {
  if (!_sdk) {
    const codingAgent = await import('@mariozechner/pi-coding-agent');
    const piAi = await import('@mariozechner/pi-ai');
    _sdk = {
      createAgentSession: codingAgent.createAgentSession,
      SessionManager: codingAgent.SessionManager,
      DefaultResourceLoader: codingAgent.DefaultResourceLoader,
      SettingsManager: codingAgent.SettingsManager,
      AuthStorage: codingAgent.AuthStorage,
      ModelRegistry: codingAgent.ModelRegistry,
      createReadTool: codingAgent.createReadTool,
      createBashTool: codingAgent.createBashTool,
      createEditTool: codingAgent.createEditTool,
      createWriteTool: codingAgent.createWriteTool,
      createGrepTool: codingAgent.createGrepTool,
      createFindTool: codingAgent.createFindTool,
      createLsTool: codingAgent.createLsTool,
      createCodingTools: codingAgent.createCodingTools,
      Type: piAi.Type,
      getModel: piAi.getModel,
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
 * The session updates `onApprovalNeeded` and `runId` before each turn so tool
 * `execute` callbacks always observe the current turn's approval handler without
 * requiring the entire tool list to be rebuilt.
 */
interface ConvertToolsContext {
  agentId: string;
  conversationId: string;
  workspaceDir?: string;
  onApprovalNeeded?: ApprovalCallback;
  runId?: string;
  queuedEvents?: CtxMillAgentEvent[];
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
          runId: config.runId ?? config.conversationId,
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
        const msg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
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
): any {
  const { provider, model, baseUrl, apiKeyRef } = harnessConfig;
  const { apiKey: resolvedApiKey } = resolveModelAuth({ provider, apiKeyRef, secrets });

  if (baseUrl) {
    return {
      id: model,
      name: model,
      provider,
      api: 'openai-completions' as const,
      baseUrl,
      apiKey: resolvedApiKey,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };
  }

  const resolved = getModelFn(provider, model);
  if (resolved) {
    return resolved;
  }

  const providerDefaults: Record<string, { baseUrl: string; api: string }> = {
    openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic' },
    google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-genai' },
  };
  const defaults = providerDefaults[provider] ?? providerDefaults.openai;

  return {
    id: model,
    name: model,
    provider,
    api: defaults.api,
    baseUrl: defaults.baseUrl,
    apiKey: resolvedApiKey,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function _piUpdateUsage(
  totalUsage: TokenUsage | undefined,
  piEvent: Record<string, unknown>,
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
  if (normalized.cost !== undefined) {
    nextUsage.cost = (nextUsage.cost ?? 0) + normalized.cost;
  }

  return nextUsage;
}

export function _piMapAgentEvent(
  piEvent: Record<string, unknown>,
  usage: TokenUsage | undefined,
): CtxMillAgentEvent | null {
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
      return { type: 'done', usage };
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
  agent: {
    replaceMessages: (messages: Array<Record<string, unknown>>) => void;
  };
};

export const PIAgentConfigSchema = z.object({
  provider: CanonicalProviderSchema.default('openai'),
  model: z.string().min(1),
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().refine((value) => URL.canParse(value)).optional(),
  extensions: z.array(z.string()).optional(),
});

export type PIAgentConfig = z.infer<typeof PIAgentConfigSchema>;

export class PIAgentHarness implements AgentHarness {
  readonly name = 'pi-agent';
  readonly configSchema = PIAgentConfigSchema;

  async openSession(config: HarnessSessionConfig, restore?: HarnessRestorePoint): Promise<HarnessSession> {
    const sdk = await getSDK();
    const cwd = config.workspaceDir ?? process.cwd();
    const harnessConfig = PIAgentConfigSchema.parse(
      JSON.parse(z.string().parse(config.harnessConfigJson)),
    );
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
    const { apiKey: resolvedApiKey } = resolveModelAuth({
      provider: harnessConfig.provider,
      apiKeyRef: harnessConfig.apiKeyRef,
      secrets: config.secrets,
    });
    const model = resolveModel(sdk.getModel, harnessConfig, config.secrets);

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
      runId: config.conversationId,
    };
    const customTools = convertTools(sdk.Type, config.tools, turnRef, extensions);

    const authStorage = sdk.AuthStorage.inMemory();
    if (resolvedApiKey) {
      authStorage.setRuntimeApiKey(harnessConfig.provider, resolvedApiKey);
      if (typeof model.api === 'string' && model.api !== harnessConfig.provider) {
        authStorage.setRuntimeApiKey(model.api, resolvedApiKey);
      }
    }
    const modelRegistry = new sdk.ModelRegistry(authStorage);
    const settingsManager = sdk.SettingsManager.inMemory();
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const created = await sdk.createAgentSession({
      cwd,
      model,
      tools: nativeTools as any[],
      customTools: customTools as any[],
      sessionManager: restore
        ? sdk.SessionManager.continueRecent(cwd)
        : sdk.SessionManager.create(cwd),
      settingsManager,
      authStorage,
      modelRegistry,
      resourceLoader,
    });
    const nativeSession: NativePiSession = created.session;

    const session = new PiAgentSession(nativeSession, config, turnRef, extensions);
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

    return traceAgentEvents(session, {
      createTracer: (input) => createAgentEventLangSmithTracer({
        agentId: config.agentId,
        conversationId: config.conversationId,
        harnessName: this.name,
        turnId: input.turnId,
      }),
    });
  }

  private buildNativeTools(
    config: HarnessSessionConfig,
    factories: {
      createReadTool: (cwd: string) => unknown;
      createBashTool: (cwd: string) => unknown;
      createEditTool: (cwd: string) => unknown;
      createWriteTool: (cwd: string) => unknown;
      createGrepTool: (cwd: string) => unknown;
      createFindTool: (cwd: string) => unknown;
      createLsTool: (cwd: string) => unknown;
      createCodingTools: (cwd: string) => unknown[];
    },
  ): unknown[] {
    const cwd = config.workspaceDir ?? process.cwd();
    const allFactories: Record<string, () => unknown> = {
      read: () => factories.createReadTool(cwd),
      bash: () => factories.createBashTool(cwd),
      edit: () => factories.createEditTool(cwd),
      write: () => factories.createWriteTool(cwd),
      grep: () => factories.createGrepTool(cwd),
      find: () => factories.createFindTool(cwd),
      ls: () => factories.createLsTool(cwd),
    };

    const primaryConf = config.nativeTools?.[0];
    if (!primaryConf) {
      return factories.createCodingTools(cwd);
    }

    let names = primaryConf.allowlist ?? Object.keys(allFactories);
    const blocked = new Set(config.nativeTools?.flatMap((nc) => nc.blocklist ?? []) ?? []);
    if (blocked.size > 0) {
      names = names.filter((n) => !blocked.has(n));
    }
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
  ) {}

  restoreTranscript(messages: Message[]): void {
    this.transcript.push(...messages);
  }

  private buildNativeHistoryMessages(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map((message, index) => ({
      role: 'user',
      content: this.formatTranscriptMessage(message),
      timestamp: this.toNativeTimestamp(message.createdAt, index),
    }));
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

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<CtxMillAgentEvent> {
    this.transcript = [...input.messages];
    this.turnRef.onApprovalNeeded = context.onApprovalNeeded ?? this.config.onApprovalNeeded;
    this.turnRef.runId = input.turnId;

    const latestMessage = input.messages[input.messages.length - 1];
    const lastUserMsg = latestMessage?.role === 'user' ? latestMessage : undefined;
    const nativeHistory = lastUserMsg
      ? input.messages.slice(0, -1)
      : input.messages;

    const eventQueue: CtxMillAgentEvent[] = [];
    let done = false;
    let totalUsage: TokenUsage | undefined;
    let unsubscribe: (() => void) | undefined;
    let aborted = false;
    let unlinkConfigAbort: () => void = () => {};
    let unlinkContextAbort: () => void = () => {};
    const accumulator = new TurnAccumulator({ turnId: input.turnId });

    try {
      this.turnRef.queuedEvents = eventQueue;
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
          }
        }
        totalUsage = _piUpdateUsage(totalUsage, piEvent);
        const mapped = _piMapAgentEvent(piEvent, totalUsage);
        if (mapped) {
          if (mapped.type === 'text_delta') {
            eventQueue.push(accumulator.appendText(mapped.content));
          } else if (mapped.type === 'done') {
            if (!aborted) {
              accumulator.recordDone({
                ...mapped,
                usage: mapped.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              });
            }
          } else {
            if (mapped.type === 'tool_call_start') {
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
          done = true;
        }
      });

      const abortNativeSession = () => {
        aborted = true;
        void Promise.resolve(this.nativeSession.abort()).catch((err) => {
          console.error('[pi-agent] abort failed:', err);
        });
      };
      unlinkConfigAbort = linkAbortSignal(this.config.signal, abortNativeSession);
      unlinkContextAbort = linkAbortSignal(context.signal, abortNativeSession);

      if (!lastUserMsg) {
        done = true;
        accumulator.recordDone({
          type: 'done',
          usage: totalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
      }

      this.nativeSession.agent.replaceMessages(this.buildNativeHistoryMessages(nativeHistory));

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

      const committed = accumulator.createMessageCommitted(this.transcript.length);
      if (committed) {
        this.transcript.push({
          id: randomUUID(),
          agentId: this.config.agentId ?? this.config.conversationId,
          role: 'assistant',
          content: committed.content,
          ...(committed.toolCalls ? { toolCalls: committed.toolCalls } : {}),
          createdAt: new Date(),
        });

        yield committed;
      }

      const doneEvent = accumulator.doneEvent();
      if (doneEvent) {
        yield doneEvent;
      }

      await promptPromise;
    } catch (err) {
      console.error('[pi-agent] deliverTurn error:', err);
      yield { type: 'error', error: String(err) };
    } finally {
      unlinkConfigAbort();
      unlinkContextAbort();
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
