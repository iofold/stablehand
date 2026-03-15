import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentHarness,
  AgentEvent as CtxMillAgentEvent,
  HarnessRunConfig,
  ApprovalRequest,
  TokenUsage,
} from './types.js';
import type { ToolDefinition } from '../tool/types.js';
import { createStubKnowledgeContext } from './shared.js';

/**
 * Lazily-loaded references to the PI Agent SDK packages.
 *
 * PI Agent requires `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.
 * By deferring the import to first use we avoid module-load failures in
 * environments that don't have these packages installed (e.g. unit tests
 * that mock the SDK).
 */
let _sdk: {
  Agent: any;
  Type: any;
  getModel: any;
} | null = null;

async function getSDK() {
  if (!_sdk) {
    const agentCore = await import('@mariozechner/pi-agent-core');
    const piAi = await import('@mariozechner/pi-ai');
    _sdk = {
      Agent: agentCore.Agent,
      Type: piAi.Type,
      getModel: piAi.getModel,
    };
  }
  return _sdk;
}

/**
 * Convert a Zod schema to a TypeBox schema for PI Agent tools.
 *
 * PI Agent uses TypeBox (via `@sinclair/typebox`) for tool parameter schemas,
 * while ctxmill uses Zod. This function performs a best-effort conversion by
 * inspecting the Zod schema shape and mapping each field to its TypeBox
 * equivalent.
 *
 * Supports: string, number, boolean, enum, optional wrappers, and arrays of
 * primitives. Unknown types fall back to Type.String().
 */
export function zodToTypeBox(
  Type: any,
  zodSchema: z.ZodObject<any>,
): any {
  const shape = zodSchema.shape;
  const props: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodVal = value as z.ZodTypeAny;
    const { schema: tbSchema, isOptional } = zodFieldToTypeBox(Type, zodVal);

    // Carry over Zod description into TypeBox schema metadata
    const desc = zodVal.description ?? (zodVal as any)?._def?.description;
    if (desc && typeof tbSchema === 'object') {
      tbSchema.description = desc;
    }

    props[key] = tbSchema;
    if (!isOptional) {
      required.push(key);
    }
  }

  return Type.Object(props);
}

/**
 * Convert a single Zod field to its TypeBox equivalent.
 * Returns { schema, isOptional }.
 */
function zodFieldToTypeBox(
  Type: any,
  zodVal: z.ZodTypeAny,
): { schema: any; isOptional: boolean } {
  // Unwrap optional
  if (zodVal instanceof z.ZodOptional) {
    const inner = zodFieldToTypeBox(Type, zodVal.unwrap());
    return { schema: Type.Optional(inner.schema), isOptional: true };
  }

  // Unwrap nullable
  if (zodVal instanceof z.ZodNullable) {
    const inner = zodFieldToTypeBox(Type, zodVal.unwrap());
    return { schema: inner.schema, isOptional: false };
  }

  // Unwrap default
  if (zodVal instanceof z.ZodDefault) {
    const inner = zodFieldToTypeBox(Type, (zodVal as any)._def.innerType);
    return { schema: inner.schema, isOptional: true };
  }

  // Primitives
  if (zodVal instanceof z.ZodString) {
    return { schema: Type.String(), isOptional: false };
  }
  if (zodVal instanceof z.ZodNumber) {
    return { schema: Type.Number(), isOptional: false };
  }
  if (zodVal instanceof z.ZodBoolean) {
    return { schema: Type.Boolean(), isOptional: false };
  }

  // Enum
  if (zodVal instanceof z.ZodEnum) {
    const values = (zodVal as any)._def.values as string[];
    return { schema: Type.Union(values.map((v: string) => Type.Literal(v))), isOptional: false };
  }

  // Array
  if (zodVal instanceof z.ZodArray) {
    const inner = zodFieldToTypeBox(Type, zodVal.element);
    return { schema: Type.Array(inner.schema), isOptional: false };
  }

  // Nested object
  if (zodVal instanceof z.ZodObject) {
    return { schema: zodToTypeBox(Type, zodVal), isOptional: false };
  }

  // Fallback: string
  return { schema: Type.String(), isOptional: false };
}

/**
 * Convert ctxmill `ToolDefinition[]` to PI Agent `AgentTool[]`.
 *
 * Each ctxmill tool is wrapped to:
 * 1. Convert its Zod input schema to TypeBox
 * 2. Map its handler to PI's execute signature
 * 3. Optionally wire HITL approval via `onApprovalNeeded`
 */
export function convertTools(
  Type: any,
  toolDefs: ToolDefinition[],
  config: HarnessRunConfig,
): any[] {
  return toolDefs.map((def) => {
    const typeBoxParams = zodToTypeBox(Type, def.input as z.ZodObject<any>);

    const piTool = {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: typeBoxParams,
      execute: async (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        _onUpdate?: (partialResult: any) => void,
      ) => {
        // HITL: if the tool requires approval, delegate to onApprovalNeeded
        if (def.requiresApproval && config.onApprovalNeeded) {
          const req: ApprovalRequest = {
            id: randomUUID(),
            runId: config.runId,
            toolName: def.name,
            args: params as Record<string, unknown>,
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
          eventBus: config.eventBus ?? undefined,
          knowledge: createStubKnowledgeContext(),
        });

        return {
          content: [{ type: 'text' as const, text: result }],
          details: {},
        };
      },
    };

    return piTool;
  });
}

/**
 * Map PI Agent provider names to ctxmill/pi-ai provider identifiers.
 * PI Agent uses provider names like 'anthropic', 'openai', 'google'.
 */
function resolveModel(
  getModelFn: any,
  config: HarnessRunConfig,
): any {
  const { provider, model, baseUrl, apiKeyRef } = config.modelConfig;
  const resolvedApiKey = apiKeyRef ? config.secrets[apiKeyRef] : undefined;

  // If there's a custom baseUrl, create a custom model definition
  if (baseUrl) {
    return {
      id: model,
      api: 'openai-completions' as const,
      baseUrl,
      apiKey: resolvedApiKey,
    };
  }

  // Try to use PI's built-in model resolution
  try {
    return getModelFn(provider, model);
  } catch (err) {
    console.warn('PI Agent model resolution failed, using fallback:', err);
    // Fallback: construct a model object manually
    return {
      id: model,
      api: 'openai-completions' as const,
      apiKey: resolvedApiKey,
    };
  }
}

/**
 * PI Agent harness adapter.
 *
 * Wraps the PI Agent framework (`@mariozechner/pi-agent-core` +
 * `@mariozechner/pi-ai`) behind the ctxmill `AgentHarness` interface,
 * converting `ToolDefinition[]` from Zod to TypeBox format and mapping
 * PI Agent events to normalized `AgentEvent` types.
 *
 * PI Agent manages its own agent loop with tool execution, steering, and
 * follow-up message queues. The harness subscribes to PI Agent events and
 * translates them to ctxmill's `AgentEvent` protocol.
 */
export class PIAgentHarness implements AgentHarness {
  readonly name = 'pi-agent';

  async *run(config: HarnessRunConfig): AsyncGenerator<CtxMillAgentEvent> {
    try {
      const sdk = await getSDK();

      // Resolve the LLM model
      const piModel = resolveModel(sdk.getModel, config);

      // Convert tools from Zod to TypeBox
      const piTools = convertTools(sdk.Type, config.tools, config);

      // Build conversation messages in PI format
      const piMessages = config.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
          if (m.role === 'user') {
            return {
              role: 'user' as const,
              content: m.content,
              timestamp: Date.now(),
            };
          }
          // For assistant messages, create a minimal PI-compatible format
          return {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: m.content }],
            api: 'openai-completions' as const,
            provider: config.modelConfig.provider,
            model: config.modelConfig.model,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop' as const,
            timestamp: Date.now(),
          };
        });

      // Map reasoning level from ctxmill to PI's ThinkingLevel
      const thinkingLevel = config.modelConfig.reasoning ?? 'off';

      // Create the PI Agent
      const agent = new sdk.Agent({
        initialState: {
          systemPrompt: config.systemPrompt,
          model: piModel,
          thinkingLevel,
          tools: piTools,
          messages: piMessages,
          isStreaming: false,
          streamMessage: null,
          pendingToolCalls: new Set(),
        },
        ...(config.modelConfig.apiKeyRef ? {
          getApiKey: async () => config.secrets[config.modelConfig.apiKeyRef!],
        } : {}),
      });

      // Collect events via subscription; yield them from the async generator
      // using a queue pattern.
      const eventQueue: CtxMillAgentEvent[] = [];
      let done = false;
      let resolveWait: (() => void) | null = null;
      let totalUsage: TokenUsage | undefined;

      const unsubscribe = agent.subscribe((piEvent: any) => {
        const mapped = this.mapPIEvent(piEvent);
        for (const ev of mapped) {
          eventQueue.push(ev);
        }

        // Track usage from turn_end events
        if (piEvent.type === 'turn_end' && piEvent.message?.usage) {
          const u = piEvent.message.usage;
          if (!totalUsage) {
            totalUsage = {
              inputTokens: u.input ?? 0,
              outputTokens: u.output ?? 0,
              totalTokens: u.totalTokens ?? 0,
              cost: u.cost?.total,
            };
          } else {
            totalUsage.inputTokens += u.input ?? 0;
            totalUsage.outputTokens += u.output ?? 0;
            totalUsage.totalTokens += u.totalTokens ?? 0;
            if (u.cost?.total != null) {
              totalUsage.cost = (totalUsage.cost ?? 0) + u.cost.total;
            }
          }
        }

        if (piEvent.type === 'agent_end') {
          done = true;
        }

        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      });

      // Wire abort signal to PI Agent's abort
      if (config.signal) {
        config.signal.addEventListener('abort', () => {
          agent.abort();
        }, { once: true });
      }

      // Send the last user message as a prompt to start the agent
      const lastUserMessage = [...config.messages].reverse().find((m) => m.role === 'user');
      if (lastUserMessage) {
        // Don't await — prompt runs the loop asynchronously
        const promptPromise = agent.prompt(lastUserMessage.content);
        promptPromise.catch((err: unknown) => {
          eventQueue.push({ type: 'error', error: String(err) });
          done = true;
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
        });
      } else {
        done = true;
      }

      // Yield events as they arrive
      while (!done || eventQueue.length > 0) {
        if (eventQueue.length === 0) {
          if (done) break;
          // Wait for next event
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
          continue;
        }
        yield eventQueue.shift()!;
      }

      // Drain remaining events
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }

      unsubscribe();
      yield { type: 'done', usage: totalUsage };
    } catch (err) {
      yield { type: 'error', error: String(err) };
    }
  }

  /**
   * Map a single PI Agent event to zero or more ctxmill `AgentEvent` instances.
   *
   * PI Agent event types:
   * - `agent_start` / `agent_end` → lifecycle
   * - `turn_start` / `turn_end` → per-LLM-call boundary
   * - `message_start` / `message_update` / `message_end` → streaming content
   * - `tool_execution_start` / `tool_execution_update` / `tool_execution_end` → tool calls
   */
  mapPIEvent(piEvent: any): CtxMillAgentEvent[] {
    const events: CtxMillAgentEvent[] = [];

    switch (piEvent.type) {
      case 'message_update': {
        // Extract text deltas from the AssistantMessageEvent
        const streamEvent = piEvent.assistantMessageEvent;
        if (streamEvent?.type === 'text_delta' && streamEvent.delta) {
          events.push({ type: 'text_delta', content: streamEvent.delta });
        }
        break;
      }

      case 'tool_execution_start': {
        events.push({
          type: 'tool_call_start',
          id: piEvent.toolCallId || randomUUID(),
          name: piEvent.toolName || 'unknown',
          args: piEvent.args ?? {},
        });
        break;
      }

      case 'tool_execution_end': {
        const resultContent = piEvent.result?.content;
        let resultStr: string;
        if (Array.isArray(resultContent)) {
          resultStr = resultContent
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('');
        } else if (typeof resultContent === 'string') {
          resultStr = resultContent;
        } else {
          resultStr = JSON.stringify(piEvent.result ?? '');
        }

        events.push({
          type: 'tool_call_end',
          id: piEvent.toolCallId || randomUUID(),
          result: resultStr,
          error: piEvent.isError ? resultStr : undefined,
          durationMs: 0, // PI doesn't track duration per-tool
        });
        break;
      }

      // agent_start, agent_end, turn_start, turn_end, message_start, message_end,
      // tool_execution_update — no direct mapping needed for ctxmill events
      default:
        break;
    }

    return events;
  }
}
