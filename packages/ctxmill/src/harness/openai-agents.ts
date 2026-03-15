import { randomUUID } from 'node:crypto';
import type {
  AgentHarness,
  AgentEvent,
  HarnessRunConfig,
  ApprovalRequest,
  TokenUsage,
} from './types.js';
import type { ToolDefinition } from '../tool/types.js';
import { createStubKnowledgeContext } from './shared.js';

/**
 * Lazily-loaded references to the `@openai/agents` SDK.
 *
 * The SDK requires zod v4 at runtime. By deferring the import to first use we
 * avoid module-load failures in environments that only have zod v3 installed
 * (e.g. unit tests that mock the SDK).
 */
let _sdk: {
  Agent: any;
  run: any;
  tool: any;
} | null = null;

async function getSDK() {
  if (!_sdk) {
    const mod = await import('@openai/agents');
    _sdk = {
      Agent: mod.Agent,
      run: mod.run,
      tool: mod.tool,
    };
  }
  return _sdk;
}

/**
 * OpenAI Agents SDK harness adapter.
 *
 * Wraps the OpenAI Agents SDK (`@openai/agents`) behind the ctxmill
 * `AgentHarness` interface, converting `ToolDefinition[]` into the SDK's
 * `tool()` format and mapping stream events to normalized `AgentEvent` types.
 *
 * The SDK manages the tool execution loop internally — the harness only needs
 * to set up the agent, invoke `run()` in streaming mode, and translate events.
 */
export class OpenAIAgentsHarness implements AgentHarness {
  readonly name = 'openai-agents';

  /**
   * Optional custom ModelProvider. When not supplied the SDK falls back to its
   * built-in OpenAI provider (which respects `OPENAI_API_KEY` /
   * `OPENAI_BASE_URL` env vars).
   */
  private modelProvider: unknown;

  constructor(opts?: { modelProvider?: unknown }) {
    this.modelProvider = opts?.modelProvider;
  }

  async *run(config: HarnessRunConfig): AsyncGenerator<AgentEvent> {
    const {
      modelConfig,
      systemPrompt,
      messages,
      tools,
      runId,
      signal,
      onApprovalNeeded,
    } = config;

    try {
      const sdk = await getSDK();

      // Step 1: Convert ToolDefinitions → OpenAI Agents SDK tools
      const oaiTools = this.convertToolsWithSDK(
        sdk,
        tools,
        runId,
        config,
        onApprovalNeeded,
      );

      // Step 2: Build the Agent
      const agent = new sdk.Agent({
        name: config.agentId,
        instructions: systemPrompt,
        tools: oaiTools,
        model: modelConfig.model,
        modelSettings: {
          temperature: modelConfig.temperature,
          maxTokens: modelConfig.maxTokens,
          topP: modelConfig.topP,
        },
      });

      // Step 3: Build input from messages
      const input = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      // Step 4: Run with streaming
      const result = await sdk.run(agent, input, {
        stream: true,
        signal,
        ...(this.modelProvider
          ? { modelProvider: this.modelProvider }
          : {}),
      });

      // Step 5: Map stream events → AgentEvent
      const toolStartTimes = new Map<string, number>();

      for await (const event of result) {
        yield* this.mapStreamEvent(event, toolStartTimes, config);
      }

      // Collect usage info if available
      const usage = this.extractUsage(result);
      yield { type: 'done', usage };
    } catch (err) {
      yield { type: 'error', error: String(err) };
    }
  }

  /**
   * Convert ctxmill `ToolDefinition[]` → OpenAI Agents SDK `FunctionTool[]`.
   *
   * Because both systems use Zod for parameter schemas, this is mostly a
   * direct mapping. The `needsApproval` field is wired to trigger the
   * `onApprovalNeeded` callback from the harness config.
   *
   * This is the public-facing method that lazily loads the SDK. For testing
   * you can call `convertToolsWithSDK` directly with a mock SDK.
   */
  async convertTools(
    toolDefs: ToolDefinition[],
    runId: string,
    config?: HarnessRunConfig,
    onApprovalNeeded?: HarnessRunConfig['onApprovalNeeded'],
  ) {
    const sdk = await getSDK();
    return this.convertToolsWithSDK(sdk, toolDefs, runId, config, onApprovalNeeded);
  }

  /**
   * Synchronous tool conversion that accepts an SDK reference directly.
   * Used internally and by tests that provide a mock SDK.
   */
  convertToolsWithSDK(
    sdk: { tool: any },
    toolDefs: ToolDefinition[],
    runId: string,
    config?: HarnessRunConfig,
    onApprovalNeeded?: HarnessRunConfig['onApprovalNeeded'],
  ) {
    return toolDefs.map((def) => {
      const needsApproval = def.requiresApproval
        ? async () => {
            if (!onApprovalNeeded) return true; // auto-approve if no handler
            const req: ApprovalRequest = {
              id: randomUUID(),
              runId,
              toolName: def.name,
              args: {},
            };
            const res = await onApprovalNeeded(req);
            return res.action === 'approve';
          }
        : undefined;

      return sdk.tool({
        name: def.name,
        description: def.description,
        parameters: def.input,
        needsApproval,
        execute: async (args: Record<string, unknown>) => {
          return def.handler(args, {
            agentId: config?.agentId ?? '',
            conversationId: runId,
            workspaceDir: config?.workspaceDir ?? process.cwd(),
            knowledge: createStubKnowledgeContext(),
            eventBus: config?.eventBus,
          });
        },
      });
    });
  }

  /**
   * Map a single `RunStreamEvent` from the OpenAI Agents SDK into zero or
   * more `AgentEvent` instances.
   */
  private *mapStreamEvent(
    event: { type: string; data?: any; name?: string; item?: any },
    toolStartTimes: Map<string, number>,
    _config: HarnessRunConfig,
  ): Generator<AgentEvent> {
    if (event.type === 'raw_model_stream_event') {
      const raw = event.data;
      // The SDK emits raw response stream events; text deltas come through
      // as `output_text_delta` events.
      if (raw && 'type' in raw && raw.type === 'output_text_delta') {
        const delta = (raw as { delta?: string }).delta;
        if (delta) {
          yield { type: 'text_delta', content: delta };
        }
      }
    } else if (event.type === 'run_item_stream_event') {
      const item = event.item;
      const eventName = event.name;

      switch (eventName) {
        case 'tool_called': {
          const callId =
            item?.rawItem?.callId || randomUUID();
          const toolName = item?.rawItem?.name || 'unknown';
          const args = item?.rawItem?.arguments || '{}';
          toolStartTimes.set(callId, Date.now());
          yield {
            type: 'tool_call_start',
            id: callId,
            name: toolName,
            args: this.tryParseJson(args),
          };
          break;
        }

        case 'tool_output': {
          const callId = item?.rawItem?.callId || randomUUID();
          const startTime = toolStartTimes.get(callId) || Date.now();
          const durationMs = Date.now() - startTime;
          toolStartTimes.delete(callId);

          const output = item?.output != null ? String(item.output) : '';
          yield {
            type: 'tool_call_end',
            id: callId,
            result: output,
            durationMs,
          };
          break;
        }

        case 'tool_approval_requested': {
          const callId = item?.rawItem?.callId || randomUUID();
          const toolName =
            item?.toolName || item?.rawItem?.name || 'unknown';
          const args = item?.rawItem?.arguments || '{}';
          yield {
            type: 'approval_needed',
            id: callId,
            tool: toolName,
            args: this.tryParseJson(args),
          };
          break;
        }

        // message_output_created, handoff_requested, etc. — no direct mapping needed
        default:
          break;
      }
    }
    // agent_updated_stream_event — no mapping needed for ctxmill events
  }

  /**
   * Extract token usage from a completed streamed result, if available.
   */
  private extractUsage(result: any): TokenUsage | undefined {
    try {
      const usage = result?.usage;
      if (usage) {
        return {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        };
      }
    } catch {
      // Usage extraction is best-effort
    }
    return undefined;
  }

  private tryParseJson(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
}
