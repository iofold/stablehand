import { randomUUID } from 'node:crypto';
import type {
  AgentHarness,
  AgentEvent,
  HarnessRunConfig,
  TokenUsage,
} from './types.js';
import type { ToolDefinition } from '../tool/types.js';
import { createStubKnowledgeContext } from './shared.js';

/**
 * Lazily-loaded references to the `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK requires zod v4 at runtime.  By deferring the import to first use
 * we avoid module-load failures in environments that only have zod v3
 * installed (e.g. unit tests that mock the SDK).
 */
let _sdk: {
  query: any;
  tool: any;
  createSdkMcpServer: any;
} | null = null;

async function getSDK() {
  if (!_sdk) {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    _sdk = {
      query: mod.query,
      tool: mod.tool,
      createSdkMcpServer: mod.createSdkMcpServer,
    };
  }
  return _sdk;
}

/**
 * Shape of a converted MCP tool definition, used by tests that supply
 * a mock SDK to `convertToolsWithSDK`.
 */
export interface ConvertedMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

/**
 * Claude Agent SDK harness adapter.
 *
 * Wraps the Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
 * behind the ctxmill `AgentHarness` interface, converting `ToolDefinition[]`
 * into SDK MCP server tools and mapping stream messages to normalized
 * `AgentEvent` types.
 *
 * Key differences from other harnesses:
 * - Tools are exposed as MCP server tools via `createSdkMcpServer()` + `tool()`
 * - `query()` is the entry point (not `new Agent()` + `run()`)
 * - `canUseTool` callback handles HITL (human-in-the-loop) approval
 * - Streaming uses an async iterator over `SDKMessage` variants
 * - The SDK is Anthropic-locked (uses the Anthropic API directly)
 */
export class ClaudeAgentsHarness implements AgentHarness {
  readonly name = 'claude-agents';

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

      // Step 1: Convert ToolDefinitions → SDK MCP server tools
      const mcpTools = this.convertToolsWithSDK(
        sdk,
        tools,
        runId,
        config,
        onApprovalNeeded,
      );

      // Step 2: Create an in-process MCP server hosting our tools
      const server = sdk.createSdkMcpServer({
        name: `ctxmill-tools-${config.agentId}`,
        version: '1.0.0',
        tools: mcpTools,
      });

      // Step 3: Build the canUseTool callback for HITL approval
      const canUseTool = this.buildCanUseTool(tools, onApprovalNeeded, runId);

      // Step 4: Extract the last user message as the prompt
      const lastUserMessage =
        messages.filter((m) => m.role === 'user').pop()?.content ?? '';

      // Step 5: Build options
      const options: Record<string, unknown> = {
        mcpServers: { 'ctxmill-tools': server },
        model: modelConfig.model,
        systemPrompt,
        cwd: config.workspaceDir || process.cwd(),
        canUseTool,
        tools: [], // disable built-in tools; our MCP server provides all tools
        ...(signal ? { abortController: new AbortController() } : {}),
      };

      // If signal is provided, wire it to the abort controller
      if (signal) {
        const ac = options.abortController as AbortController;
        signal.addEventListener('abort', () => ac.abort(), { once: true });
      }

      // Step 6: Run the query and stream events
      const stream = sdk.query({
        prompt: lastUserMessage,
        options,
      });

      const toolStartTimes = new Map<string, number>();

      for await (const message of stream) {
        yield* this.mapSDKMessage(message, toolStartTimes);
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: String(err) };
    }
  }

  /**
   * Convert ctxmill `ToolDefinition[]` → Claude Agent SDK `SdkMcpToolDefinition[]`.
   *
   * Each tool is wrapped via the SDK's `tool()` helper to produce an MCP tool
   * definition that `createSdkMcpServer` expects.
   *
   * This is the public-facing method that lazily loads the SDK.  For testing
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
  ): ConvertedMcpTool[] {
    return toolDefs.map((def) => {
      return sdk.tool(
        def.name,
        def.description,
        this.zodToRawShape(def.input),
        async (args: Record<string, unknown>) => {
          // HITL: check approval before executing
          if (def.requiresApproval && onApprovalNeeded) {
            const req = {
              id: randomUUID(),
              runId,
              toolName: def.name,
              args,
            };
            const res = await onApprovalNeeded(req);
            if (res.action !== 'approve') {
              return {
                content: [{ type: 'text' as const, text: 'Tool call was rejected by the user.' }],
              };
            }
          }

          const result = await def.handler(args, {
            agentId: config?.agentId ?? '',
            conversationId: runId,
            workspaceDir: config?.workspaceDir ?? process.cwd(),
            knowledge: createStubKnowledgeContext(),
            eventBus: config?.eventBus,
          });

          return {
            content: [{ type: 'text' as const, text: result }],
          };
        },
      );
    });
  }

  /**
   * Build a `canUseTool` callback for HITL approval of tools that require it.
   *
   * The Claude Agent SDK calls `canUseTool` before every tool invocation.
   * We check whether the tool is marked `requiresApproval` and, if so,
   * delegate to the harness `onApprovalNeeded` callback.
   */
  buildCanUseTool(
    toolDefs: ToolDefinition[],
    onApprovalNeeded: HarnessRunConfig['onApprovalNeeded'],
    runId: string,
  ) {
    const approvalSet = new Set(
      toolDefs.filter((t) => t.requiresApproval).map((t) => t.name),
    );

    return async (
      toolName: string,
      input: Record<string, unknown>,
      _options: { signal: AbortSignal; toolUseID: string },
    ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }> => {
      // Allow tools that don't need approval
      if (!approvalSet.has(toolName)) {
        return { behavior: 'allow' };
      }

      // Auto-approve if no handler
      if (!onApprovalNeeded) {
        return { behavior: 'allow' };
      }

      const req = {
        id: _options.toolUseID || randomUUID(),
        runId,
        toolName,
        args: input,
      };
      const res = await onApprovalNeeded(req);
      if (res.action === 'approve') {
        return { behavior: 'allow' };
      }
      return { behavior: 'deny', message: 'Tool call was rejected by the user.' };
    };
  }

  /**
   * Map an `SDKMessage` from the Claude Agent SDK into zero or more
   * `AgentEvent` instances.
   *
   * The SDK emits a variety of message types.  We map the ones relevant
   * to the ctxmill `AgentEvent` protocol:
   * - `assistant` → text_delta (from content blocks) + tool_call_start
   * - `stream_event` → text_delta (partial streaming)
   * - `result` → done (with usage)
   * - `tool_progress` → (ignored, tool timing tracked internally)
   */
  *mapSDKMessage(
    message: { type: string; [key: string]: any },
    toolStartTimes: Map<string, number>,
  ): Generator<AgentEvent> {
    switch (message.type) {
      case 'assistant': {
        // Full assistant message — extract text and tool_use content blocks
        const betaMessage = message.message;
        if (!betaMessage?.content) break;

        for (const block of betaMessage.content) {
          if (block.type === 'text' && block.text) {
            yield { type: 'text_delta', content: block.text };
          } else if (block.type === 'tool_use') {
            const callId = block.id || randomUUID();
            toolStartTimes.set(callId, Date.now());
            yield {
              type: 'tool_call_start',
              id: callId,
              name: block.name || 'unknown',
              args: block.input ?? {},
            };
          } else if (block.type === 'tool_result') {
            const callId = block.tool_use_id || randomUUID();
            const startTime = toolStartTimes.get(callId) ?? Date.now();
            const durationMs = Date.now() - startTime;
            toolStartTimes.delete(callId);

            const resultText =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((c: any) => c.type === 'text')
                      .map((c: any) => c.text)
                      .join('')
                  : JSON.stringify(block.content);

            yield {
              type: 'tool_call_end',
              id: callId,
              result: resultText,
              durationMs,
            };
          }
        }
        break;
      }

      case 'stream_event': {
        // Partial streaming event — contains BetaRawMessageStreamEvent
        const event = message.event;
        if (!event) break;

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text_delta', content: delta.text };
          } else if (delta?.type === 'input_json_delta') {
            // Tool input streaming — we don't emit events for partial args
          }
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            const callId = block.id || randomUUID();
            toolStartTimes.set(callId, Date.now());
            yield {
              type: 'tool_call_start',
              id: callId,
              name: block.name || 'unknown',
              args: {},
            };
          }
        }
        break;
      }

      case 'result': {
        // Result message with usage information
        const usage = this.extractUsage(message);
        yield { type: 'done', usage };
        break;
      }

      case 'tool_progress': {
        // Tool progress — we track timing but don't emit specific events
        break;
      }

      case 'tool_use_summary': {
        // Tool use summary — informational, no mapping needed
        break;
      }

      default:
        // system, user, auth_status, etc. — no mapping needed
        break;
    }
  }

  /**
   * Extract token usage from a completed SDKResultMessage.
   */
  private extractUsage(message: any): TokenUsage | undefined {
    try {
      const usage = message.usage;
      if (usage) {
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        return {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cost: message.total_cost_usd,
        };
      }
    } catch {
      // Usage extraction is best-effort
    }
    return undefined;
  }

  /**
   * Extract the raw shape from a Zod schema for the SDK's `tool()` helper.
   *
   * The Claude Agent SDK's `tool()` function expects a ZodRawShape (the
   * object passed to `z.object()`), not a ZodObject. We extract the shape
   * from the schema if it's a ZodObject, or return an empty shape as a
   * fallback.
   */
  private zodToRawShape(schema: any): Record<string, unknown> {
    // ZodObject stores its shape in `.shape` or `._def.shape()`
    if (schema?.shape) {
      return typeof schema.shape === 'function' ? schema.shape() : schema.shape;
    }
    if (schema?._def?.shape) {
      return typeof schema._def.shape === 'function'
        ? schema._def.shape()
        : schema._def.shape;
    }
    return {};
  }
}
