/**
 * ConnectRPC implementation of OrchestratorService.
 *
 * The OrchestratorService is exposed by the orchestrator and called by sandbox
 * containers for:
 *   - Tool callbacks (RequestTool)
 *   - Event bus emissions (EmitEvent)
 *   - Secret refresh (RefreshSecrets) — stub for P2+
 */

import { ConnectError, Code } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  RequestToolResponseSchema,
  EmitEventResponseSchema,
  RefreshSecretsResponseSchema,
  type RequestToolRequest,
  type RequestToolResponse,
  type EmitEventRequest,
  type EmitEventResponse,
  type RefreshSecretsRequest,
  type RefreshSecretsResponse,
} from '@ctxmill/proto/sandbox/v1';
import type { TypedEventBus } from '../../events/bus.js';

/**
 * Context passed to each orchestrator-side tool handler when dispatching
 * a tool call from a sandbox.
 */
export interface ToolHandlerContext {
  runId: string;
  agentId: string;
  requestId: string;
}

/**
 * A handler for an orchestrator-side tool.
 * Receives parsed arguments and authorization context, returns a JSON-serializable result.
 */
export type OrchestratorToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<string>;

/**
 * Registry of orchestrator-side tool handlers that can be called by sandboxes
 * via the RequestTool RPC.
 */
export interface OrchestratorToolRegistry {
  get(toolName: string): OrchestratorToolHandler | undefined;
  set(toolName: string, handler: OrchestratorToolHandler): void;
  has(toolName: string): boolean;
}

/**
 * In-memory tool handler registry.
 */
export class DefaultOrchestratorToolRegistry implements OrchestratorToolRegistry {
  private handlers = new Map<string, OrchestratorToolHandler>();

  get(toolName: string): OrchestratorToolHandler | undefined {
    return this.handlers.get(toolName);
  }

  set(toolName: string, handler: OrchestratorToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  has(toolName: string): boolean {
    return this.handlers.has(toolName);
  }
}

/**
 * Dependencies required by the OrchestratorService implementation.
 */
export interface OrchestratorServiceDeps {
  eventBus: TypedEventBus;
  toolRegistry: OrchestratorToolRegistry;
}

/**
 * Creates the handler implementations for OrchestratorService RPCs.
 *
 * Returns an object compatible with ConnectRouter.service() that maps each
 * RPC method name to its handler function.
 */
export function createOrchestratorServiceImpl(deps: OrchestratorServiceDeps) {
  const { eventBus, toolRegistry } = deps;

  return {
    /**
     * RequestTool — sandbox calls this to execute an orchestrator-side tool.
     *
     * Looks up the tool handler by name, parses the JSON arguments, executes
     * the handler, and returns the result (or an error).
     */
    async requestTool(req: RequestToolRequest): Promise<RequestToolResponse> {
      const { runId, agentId, toolName, argsJson, requestId } = req;

      if (!toolName) {
        throw new ConnectError('tool_name is required', Code.InvalidArgument);
      }

      const handler = toolRegistry.get(toolName);
      if (!handler) {
        return create(RequestToolResponseSchema, {
          requestId,
          result: '',
          error: `Unknown orchestrator tool: ${toolName}`,
        });
      }

      let args: Record<string, unknown> = {};
      if (argsJson) {
        try {
          args = JSON.parse(argsJson) as Record<string, unknown>;
        } catch {
          return create(RequestToolResponseSchema, {
            requestId,
            result: '',
            error: `Invalid args_json: failed to parse JSON`,
          });
        }
      }

      try {
        const result = await handler(args, { runId, agentId, requestId });
        return create(RequestToolResponseSchema, {
          requestId,
          result,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return create(RequestToolResponseSchema, {
          requestId,
          result: '',
          error: errorMsg,
        });
      }
    },

    /**
     * EmitEvent — sandbox calls this to emit an event on the orchestrator's EventBus.
     *
     * The event is dispatched for SSE broadcast and trigger processing.
     */
    async emitEvent(req: EmitEventRequest): Promise<EmitEventResponse> {
      const { runId, eventType, payloadJson } = req;

      if (!eventType) {
        throw new ConnectError('event_type is required', Code.InvalidArgument);
      }

      let payload: Record<string, unknown> = {};
      if (payloadJson) {
        try {
          payload = JSON.parse(payloadJson) as Record<string, unknown>;
        } catch {
          throw new ConnectError('Invalid payload_json: failed to parse JSON', Code.InvalidArgument);
        }
      }

      // Inject runId into the payload so downstream handlers have context
      payload.runId = runId;

      // Extract agentId from payload if present, otherwise use empty string
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';

      eventBus.emitCustom(eventType, agentId, payload);

      return create(EmitEventResponseSchema, {});
    },

    /**
     * RefreshSecrets — stub for P2+ feature.
     *
     * In future, this will re-derive secrets for a running sandbox without
     * requiring a restart.
     */
    async refreshSecrets(req: RefreshSecretsRequest): Promise<RefreshSecretsResponse> {
      // Stub — not implemented yet
      return create(RefreshSecretsResponseSchema, {
        success: false,
        error: 'RefreshSecrets is not yet implemented (P2+ feature)',
        secretsPath: '',
      });
    },
  };
}

/**
 * Registers default orchestrator-side tool handlers in the registry.
 *
 * Currently registers:
 *   - `emit-event`: Emits a custom event on the EventBus (convenience tool
 *     that sandboxes can call as a tool instead of using the EmitEvent RPC directly)
 */
export function registerDefaultToolHandlers(
  registry: OrchestratorToolRegistry,
  eventBus: TypedEventBus,
): void {
  registry.set('emit-event', async (args, ctx) => {
    const eventType = typeof args.type === 'string' ? args.type
      : typeof args.event_type === 'string' ? args.event_type
      : 'custom';
    const payload = typeof args.payload === 'object' && args.payload !== null
      ? args.payload as Record<string, unknown>
      : {};

    payload.runId = ctx.runId;
    payload.agentId = ctx.agentId;

    eventBus.emitCustom(eventType, ctx.agentId, payload);

    return JSON.stringify({ ok: true, eventType });
  });
}
