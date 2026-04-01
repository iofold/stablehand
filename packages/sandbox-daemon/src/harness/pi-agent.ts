import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentHarness,
  AgentEvent as CtxMillAgentEvent,
  ApprovalCallback,
  ApprovalRequest,
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
import { createStubKnowledgeContext, resolveSecretRef } from './shared.js';

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
}

export function convertTools(
  Type: any,
  toolDefs: ToolDefinition[],
  config: ConvertToolsContext,
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
        const req: ApprovalRequest = {
          id: toolCallId,
          runId: config.runId ?? config.conversationId,
          toolName: def.name,
          args: params,
        };
        const res = await config.onApprovalNeeded(req);
        if (res.action !== 'approve') {
          return {
            content: [{ type: 'text' as const, text: 'Tool call was rejected by the user.' }],
            details: {},
          };
        }
      }

      const result = await def.handler(params, {
        agentId: config.agentId,
        conversationId: config.conversationId,
        workspaceDir: config.workspaceDir || process.cwd(),
        eventBus: undefined,
        knowledge: createStubKnowledgeContext(),
      });

      return {
        content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }],
        details: {},
      };
    },
  }));
}

function resolveModel(
  getModelFn: any,
  harnessConfig: PIAgentConfig,
  secrets: ResolvedSecrets,
): any {
  const { provider, model, baseUrl, apiKeyRef } = harnessConfig;
  const resolvedApiKey = resolveSecretRef(apiKeyRef, secrets);

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

  const nextUsage: TokenUsage = totalUsage ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  nextUsage.inputTokens += typeof usage.input === 'number' ? usage.input : 0;
  nextUsage.outputTokens += typeof usage.output === 'number' ? usage.output : 0;
  nextUsage.totalTokens += typeof usage.totalTokens === 'number' ? usage.totalTokens : 0;

  const totalCost = (usage.cost as { total?: unknown } | undefined)?.total;
  if (typeof totalCost === 'number') {
    nextUsage.cost = (nextUsage.cost ?? 0) + totalCost;
  }

  return nextUsage;
}

function _piMapAgentEvent(
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
  provider: z.enum(['openai', 'anthropic', 'google']).default('openai'),
  model: z.string().min(1),
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().refine((value) => URL.canParse(value)).optional(),
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
    const resolvedApiKey = resolveSecretRef(harnessConfig.apiKeyRef, config.secrets);
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
    const customTools = convertTools(sdk.Type, config.tools, turnRef);

    const authStorage = sdk.AuthStorage.inMemory();
    if (resolvedApiKey) {
      authStorage.setRuntimeApiKey(harnessConfig.provider, resolvedApiKey);
    }
    const modelRegistry = new sdk.ModelRegistry(authStorage);
    const settingsManager = sdk.SettingsManager.inMemory();
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      systemPromptOverride: () => config.systemPrompt,
      appendSystemPromptOverride: () => [],
      skillsOverride: (current: { diagnostics: unknown }) => ({
        skills: [],
        diagnostics: current.diagnostics,
      }),
      promptsOverride: (current: { diagnostics: unknown }) => ({
        prompts: [],
        diagnostics: current.diagnostics,
      }),
      agentsFilesOverride: () => ({ agentsFiles: [] }),
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

    const session = new PiAgentSession(nativeSession, config, turnRef);
    if (restore) {
      const restoredTranscript = restore.payload['transcript'];
      if (Array.isArray(restoredTranscript) && restoredTranscript.length > 0) {
        session.restoreTranscript(restoredTranscript as Message[]);
      }
    }

    return session;
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

  updateUsage(
    totalUsage: TokenUsage | undefined,
    piEvent: Record<string, unknown>,
  ): TokenUsage | undefined {
    return _piUpdateUsage(totalUsage, piEvent);
  }

  mapPiAgentEvent(
    piEvent: Record<string, unknown>,
    usage: TokenUsage | undefined,
  ): CtxMillAgentEvent | null {
    return _piMapAgentEvent(piEvent, usage);
  }

}

class PiAgentSession implements HarnessSession {
  private readonly transcript: Message[] = [];

  constructor(
    private readonly nativeSession: NativePiSession,
    private readonly config: HarnessSessionConfig,
    private readonly turnRef: ConvertToolsContext,
  ) {}

  restoreTranscript(messages: Message[]): void {
    this.transcript.push(...messages);
  }

  async *deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<CtxMillAgentEvent> {
    this.turnRef.onApprovalNeeded = context.onApprovalNeeded ?? this.config.onApprovalNeeded;
    this.turnRef.runId = input.turnId;

    const { createPiLangSmithTracer } = await import('./pi-langsmith-tracer.js');
    const tracer = await createPiLangSmithTracer(
      this.config.agentId,
      this.config.conversationId,
    );

    const lastUserMsg = [...input.messages].reverse().find((m) => m.role === 'user');

    const eventQueue: CtxMillAgentEvent[] = [];
    let done = false;
    let totalUsage: TokenUsage | undefined;
    let unsubscribe: (() => void) | undefined;
    let assistantText = '';
    let doneEvent: Extract<CtxMillAgentEvent, { type: 'done' }> | undefined;
    const accumulatedToolCalls: Array<
      NonNullable<Message['toolCalls']>[number] & { args: string; status: 'complete' | 'error' }
    > = [];

    try {
      unsubscribe = this.nativeSession.subscribe((piEvent: Record<string, unknown>) => {
        const eventType = typeof piEvent.type === 'string' ? piEvent.type : 'unknown';
        const eventKeys = Object.keys(piEvent).filter((k) => k !== 'type').join(',');
        console.log(`[pi-agent] SDK event: ${eventType} keys=[${eventKeys}]`);
        if (eventType === 'message_end' || eventType === 'turn_end' || eventType === 'message_start') {
          console.log(`[pi-agent] SDK event payload: ${JSON.stringify(piEvent).slice(0, 500)}`);
        }
        tracer?.onEvent(piEvent);
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
            assistantText += mapped.content;
            eventQueue.push(mapped);
          } else if (mapped.type === 'done') {
            doneEvent = mapped;
          } else {
            if (mapped.type === 'tool_call_start') {
              accumulatedToolCalls.push({
                id: mapped.id,
                name: mapped.name,
                arguments: typeof mapped.args === 'object' && mapped.args !== null && !Array.isArray(mapped.args)
                  ? Object.fromEntries(Object.entries(mapped.args))
                  : {},
                args: typeof mapped.args === 'string' ? mapped.args : JSON.stringify(mapped.args ?? {}),
                status: 'complete',
              });
            } else if (mapped.type === 'tool_call_end' && mapped.error) {
              const existing = accumulatedToolCalls.find((tc) => tc.id === mapped.id);
              if (existing) {
                existing.status = 'error';
              }
            }
            eventQueue.push(mapped);
          }
        }
        if (piEvent.type === 'agent_end') {
          done = true;
        }
      });

      if (context.signal) {
        context.signal.addEventListener(
          'abort',
          () => {
            void Promise.resolve(this.nativeSession.abort()).catch((err) => {
              console.error('[pi-agent] abort failed:', err);
            });
          },
          { once: true },
        );
      }

      if (!lastUserMsg) {
        done = true;
        eventQueue.push({ type: 'done', usage: totalUsage });
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

      const committedToolCalls: Message['toolCalls'] | undefined = accumulatedToolCalls.length > 0
        ? accumulatedToolCalls
        : undefined;

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
          type: 'message_committed' as const,
          role: 'assistant' as const,
          content: assistantText,
          ...(committedToolCalls ? { toolCalls: committedToolCalls } : {}),
          turnId: input.turnId,
          messageSeq: this.transcript.length - 1,
        };
      }

      if (doneEvent) {
        yield doneEvent;
      }

      await promptPromise;
    } catch (err) {
      console.error('[pi-agent] deliverTurn error:', err);
      yield { type: 'error', error: String(err) };
    } finally {
      unsubscribe?.();
      await tracer?.flush();
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
    this.nativeSession.dispose();
  }
}
