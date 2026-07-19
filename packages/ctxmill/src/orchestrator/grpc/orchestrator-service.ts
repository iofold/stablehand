/**
 * ConnectRPC implementation of OrchestratorService.
 *
 * The OrchestratorService is exposed by the orchestrator and called by sandbox
 * containers for:
 *   - Tool callbacks (RequestTool)
 *   - Event bus emissions (EmitEvent)
 */

import { ConnectError, Code } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  RequestToolResponseSchema,
  EmitEventResponseSchema,
  RegisterArtifactResponseSchema,
  ResolveArtifactResponseSchema,
  ArtifactMetaSchema,
  type RequestToolRequest,
  type RequestToolResponse,
  type EmitEventRequest,
  type EmitEventResponse,
  type RegisterArtifactRequest,
  type RegisterArtifactResponse,
  type ResolveArtifactRequest,
  type ResolveArtifactResponse,
} from '@ctxmill/proto/sandbox/v1';
import type { TypedEventBus } from '../../events/bus.js';
import type { InterruptManager } from '../interrupt.js';
import type { DatabaseRepository } from '../../database/repository.js';

/**
 * Context passed to each orchestrator-side tool handler when dispatching
 * a tool call from a sandbox.
 */
export interface ToolHandlerContext {
  turnId: string;
  agentId: string;
  conversationId?: string;
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
  get(toolName: string, agentId?: string): OrchestratorToolHandler | undefined;
  set(toolName: string, handler: OrchestratorToolHandler): void;
  has(toolName: string, agentId?: string): boolean;
}

export interface ToolRegistryDelegate {
  getTool(name: string, agentId?: string): { handler: (input: unknown, ctx: import('@ctxmill/sandbox-daemon').ToolContext) => Promise<string> } | undefined;
}

export type ToolContextFactory = (ctx: ToolHandlerContext) => import('@ctxmill/sandbox-daemon').ToolContext;

function ensureConnectError(err: unknown): ConnectError {
  if (err instanceof ConnectError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const detail = stack ? `${message}\n${stack}` : message;
  return new ConnectError(detail, Code.Internal);
}

async function completeToolDedupOrThrow(
  repository: DatabaseRepository,
  requestId: string,
  result: string | null,
  error: string | null,
  phase: string,
): Promise<void> {
  try {
    await repository.completeToolDedup(requestId, result, error);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[OrchestratorService] Failed to finalize tool dedup for ${requestId}:`, err);
    throw new ConnectError(
      `Failed to finalize tool request ${requestId} after ${phase}: ${message}`,
      Code.Unavailable,
    );
  }
}

export class DefaultOrchestratorToolRegistry implements OrchestratorToolRegistry {
  private handlers = new Map<string, OrchestratorToolHandler>();
  private delegate?: ToolRegistryDelegate;
  private makeToolContext?: ToolContextFactory;

  constructor(delegate?: ToolRegistryDelegate, makeToolContext?: ToolContextFactory) {
    this.delegate = delegate;
    this.makeToolContext = makeToolContext;
  }

  get(toolName: string, agentId?: string): OrchestratorToolHandler | undefined {
    const builtin = this.handlers.get(toolName);
    if (builtin) return builtin;

    if (this.delegate && this.makeToolContext) {
      const tool = this.delegate.getTool(toolName, agentId);
      if (tool) {
        const ctxFactory = this.makeToolContext;
        return async (args, ctx) => tool.handler(args, ctxFactory(ctx));
      }
    }

    return undefined;
  }

  set(toolName: string, handler: OrchestratorToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  has(toolName: string, agentId?: string): boolean {
    if (this.handlers.has(toolName)) return true;
    return this.delegate?.getTool(toolName, agentId) != null;
  }
}

/**
 * Dependencies required by the OrchestratorService implementation.
 */
export interface OrchestratorServiceDeps {
  eventBus: TypedEventBus;
  toolRegistry: OrchestratorToolRegistry;
  repository?: DatabaseRepository;
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
      try {
        const { turnId, agentId, toolName, argsJson, requestId } = req;

        if (!toolName) {
          throw new ConnectError('tool_name is required', Code.InvalidArgument);
        }

        let dedupInserted = false;
        if (requestId && deps.repository) {
          const inserted = await deps.repository.tryInsertToolDedup(requestId, turnId, toolName);
          if (!inserted) {
            const existing = await deps.repository.getToolDedup(requestId);
            if (existing) {
              if (existing.turnId !== turnId || existing.toolName !== toolName) {
                throw new ConnectError(
                  `Request ID ${requestId} collision: different turn/tool`,
                  Code.InvalidArgument,
                );
              }

              if (existing.status === 'completed') {
                return create(RequestToolResponseSchema, {
                  requestId,
                  result: existing.result ?? '',
                });
              }

              if (existing.status === 'failed') {
                return create(RequestToolResponseSchema, {
                  requestId,
                  result: '',
                  error: existing.error ?? 'Tool execution failed (cached)',
                });
              }

              throw new ConnectError(
                `Tool ${toolName} already executing for request ${requestId}`,
                Code.Unavailable,
              );
            }
          } else {
            dedupInserted = true;
          }
        }

        const failToolRequest = async (error: string, phase: string): Promise<RequestToolResponse> => {
          if (dedupInserted && deps.repository) {
            await completeToolDedupOrThrow(
              deps.repository,
              requestId,
              null,
              error,
              phase,
            );
          }
          return create(RequestToolResponseSchema, {
            requestId,
            result: '',
            error,
          });
        };

        const handler = toolRegistry.get(toolName, agentId);
        if (!handler) {
          return failToolRequest(`Unknown orchestrator tool: ${toolName}`, 'unknown tool');
        }

        let args: Record<string, unknown> = {};
        if (argsJson) {
          try {
            args = JSON.parse(argsJson) as Record<string, unknown>;
          } catch {
            return failToolRequest('Invalid args_json: failed to parse JSON', 'invalid args_json');
          }
        }

        const turn = deps.repository ? await deps.repository.getTurn(turnId) : undefined;
        let result: string;
        try {
          result = await handler(args, {
            turnId,
            agentId,
            ...(turn?.conversationId ? { conversationId: turn.conversationId } : {}),
            requestId,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return failToolRequest(errorMsg, 'failed execution');
        }

        if (dedupInserted && deps.repository) {
          await completeToolDedupOrThrow(
            deps.repository,
            requestId,
            result,
            null,
            'successful execution',
          );
        }
        return create(RequestToolResponseSchema, {
          requestId,
          result,
        });
      } catch (err) {
        throw ensureConnectError(err);
      }
    },

    /**
     * EmitEvent — sandbox calls this to emit an event on the orchestrator's EventBus.
     *
     * The event is dispatched for SSE broadcast and trigger processing.
     */
    async emitEvent(req: EmitEventRequest): Promise<EmitEventResponse> {
      try {
        const { turnId, eventType, payloadJson } = req;

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

        payload.turnId = turnId;

        // Extract agentId from payload if present, otherwise use empty string
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';

        try {
          await eventBus.emitCustomAsync(eventType, agentId, payload);
        } catch (err) {
          console.error(`[OrchestratorService] EmitEvent failed for ${eventType}:`, err);
          throw ensureConnectError(err);
        }

        return create(EmitEventResponseSchema, {});
      } catch (err) {
        throw ensureConnectError(err);
      }
    },

    async registerArtifact(req: RegisterArtifactRequest): Promise<RegisterArtifactResponse> {
      const { artifact } = req;
      if (!artifact || !artifact.name) {
        throw new ConnectError('artifact with name is required', Code.InvalidArgument);
      }

      try {
        if (deps.repository) {
          const row = await deps.repository.saveArtifact({
            id: artifact.id || undefined,
            agentId: artifact.agentId,
            turnId: artifact.turnId || req.turnId || undefined,
            name: artifact.name,
            mimeType: artifact.mimeType,
            sizeBytes: Number(artifact.sizeBytes),
            storageKey: artifact.storageKey,
            bucket: artifact.bucket,
            metadata: artifact.metadataJson ? JSON.parse(artifact.metadataJson) : undefined,
          });

          return create(RegisterArtifactResponseSchema, {
            artifactId: row.id,
          });
        }

        return create(RegisterArtifactResponseSchema, {
          artifactId: artifact.id || '',
          error: 'No repository configured for artifact storage',
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return create(RegisterArtifactResponseSchema, {
          artifactId: '',
          error: errorMsg,
        });
      }
    },

    async resolveArtifact(req: ResolveArtifactRequest): Promise<ResolveArtifactResponse> {
      const { artifactId, agentId: callerAgentId } = req;
      if (!artifactId) {
        throw new ConnectError('artifact_id is required', Code.InvalidArgument);
      }

      try {
        if (!deps.repository) {
          return create(ResolveArtifactResponseSchema, {
            error: 'No repository configured for artifact storage',
          });
        }

        const row = await deps.repository.getArtifact(artifactId);
        // Ownership boundary: the callback-auth interceptor has already verified
        // that req.agentId is the true authenticated sandbox agent, so an
        // owned artifact belonging to a different agent must not be resolvable
        // across sandboxes. Unowned rows (agentId null — orphaned or operator
        // uploads) and open/dev mode (callerAgentId empty) stay resolvable, and
        // a cross-agent hit is reported as not-found to avoid an existence oracle.
        if (!row || (callerAgentId && row.agentId && row.agentId !== callerAgentId)) {
          return create(ResolveArtifactResponseSchema, {
            error: `Artifact not found: ${artifactId}`,
          });
        }

        return create(ResolveArtifactResponseSchema, {
          artifact: create(ArtifactMetaSchema, {
            id: row.id,
            agentId: row.agentId ?? '',
            turnId: row.turnId ?? '',
            name: row.name,
            mimeType: row.mimeType,
            sizeBytes: BigInt(row.sizeBytes),
            storageKey: row.storageKey,
            bucket: row.bucket,
            metadataJson: row.metadata ? JSON.stringify(row.metadata) : '',
            createdAt: BigInt(row.createdAt),
          }),
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return create(ResolveArtifactResponseSchema, { error: errorMsg });
      }
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
export interface RegisterToolHandlersDeps {
  eventBus: TypedEventBus;
  interruptManager?: InterruptManager;
  repository?: DatabaseRepository;
}

export function registerDefaultToolHandlers(
  registry: OrchestratorToolRegistry,
  eventBusOrDeps: TypedEventBus | RegisterToolHandlersDeps,
): void {
  const deps: RegisterToolHandlersDeps =
    'emit' in eventBusOrDeps
      ? { eventBus: eventBusOrDeps }
      : eventBusOrDeps;

  const { eventBus, interruptManager, repository } = deps;

  registry.set('emit-event', async (args, ctx) => {
    if (typeof args.type !== 'string' || args.type.trim() === '') {
      return 'Error: emit-event requires a non-empty string "type"';
    }

    const eventType = args.type;
    const payload = typeof args.payload === 'object' && args.payload !== null
      ? args.payload as Record<string, unknown>
      : {};

    payload.turnId = ctx.turnId;
    payload.conversationId = ctx.conversationId;
    payload.agentId = ctx.agentId;

    await eventBus.emitCustomAsync(eventType, ctx.agentId, payload);

    return JSON.stringify({ ok: true, eventType });
  });

  if (interruptManager) {
    registry.set('request-approval', async (args, ctx) => {
      const reason = typeof args.reason === 'string' ? args.reason : 'Tool requires approval';

      const turn = repository ? await repository.getTurn(ctx.turnId) : undefined;
      const sandboxSessionId = turn?.sandboxSessionId ?? undefined;

      const resolution = await interruptManager.waitForApproval(
        ctx.turnId,
        ctx.agentId,
        ctx.requestId,
        'request-approval',
        { ...args, reason },
        300_000,
        sandboxSessionId,
        turn?.conversationId ?? undefined,
      );

      if (resolution.action === 'approve') {
        return JSON.stringify({ approved: true, action: 'approve' });
      }
      if (resolution.action === 'suspend') {
        return JSON.stringify({ approved: false });
      }
      return JSON.stringify({ approved: false, action: resolution.action, reason: resolution.data ?? resolution.action });
    });
  }
}
