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
} from '@stablehand/proto/sandbox/v1';
import type { TypedEventBus } from '../../events/bus.js';
import { ArtifactRegistrationService } from '../../artifact/registration-service.js';
import { validateArtifactRegistrationFields } from '../../artifact/validation.js';
import type { InterruptManager } from '../interrupt.js';
import type {
  DatabaseRepository,
  ExpectedTurnDeliveryFence,
  SandboxSessionActiveGeneration,
} from '../../database/repository.js';
import {
  resolveGrpcCallbackAuthConfig,
  type GrpcCallbackAuthConfig,
} from './callback-auth.js';
import {
  validateTurnDeliveryCapabilitySignature,
  type TurnDeliveryCapabilityClaims,
} from './turn-delivery-capability.js';
import type { ToolApprovalGate } from '../tool-approval-gate.js';
import {
  EDIT_DOCUMENT_TOOL_NAME,
  editDocumentInputSchema,
  editDocumentResult,
} from '../../tool/builtin/edit-document.js';

/**
 * Context passed to each orchestrator-side tool handler when dispatching
 * a tool call from a sandbox.
 */
export interface ToolHandlerContext {
  turnId: string;
  sandboxSessionId?: string;
  agentId: string;
  conversationId?: string;
  requestId: string;
  deliveryFence?: ExpectedTurnDeliveryFence;
  activeGeneration?: SandboxSessionActiveGeneration;
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
  getTool(name: string, agentId?: string): {
    handler: (input: unknown, ctx: import('@stablehand/sandbox-daemon').ToolContext) => Promise<string>;
    requiresApproval?: boolean;
  } | undefined;
}

export interface DefaultOrchestratorToolRegistryOptions {
  /**
   * Wraps provider tools that declare `requiresApproval` (ctx-9gy9). Without
   * it, a gated provider tool refuses to run rather than running unasked.
   */
  approvalGate?: ToolApprovalGate;
}

export type ToolContextFactory = (ctx: ToolHandlerContext) => import('@stablehand/sandbox-daemon').ToolContext;

function ensureConnectError(err: unknown): ConnectError {
  if (err instanceof ConnectError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const detail = stack ? `${message}\n${stack}` : message;
  return new ConnectError(detail, Code.Internal);
}

interface SandboxCallbackIdentity {
  turnId: string;
  sandboxSessionId: string;
  agentId: string;
}

interface AdmittedSandboxCallback {
  claims: TurnDeliveryCapabilityClaims;
  conversationId?: string;
}

function requireCallbackIdentity(identity: SandboxCallbackIdentity): void {
  if (!identity.turnId) {
    throw new ConnectError('turn_id is required', Code.InvalidArgument);
  }
  if (!identity.sandboxSessionId) {
    throw new ConnectError('sandbox_session_id is required', Code.InvalidArgument);
  }
  if (!identity.agentId) {
    throw new ConnectError('agent_id is required', Code.InvalidArgument);
  }
}

async function admitLiveSandboxCallback(
  repository: DatabaseRepository | undefined,
  identity: SandboxCallbackIdentity,
  deliveryCapability: RequestToolRequest['deliveryCapability'],
  authConfig: GrpcCallbackAuthConfig,
): Promise<AdmittedSandboxCallback | undefined> {
  if (!repository) {
    return undefined;
  }
  requireCallbackIdentity(identity);
  const claims = validateTurnDeliveryCapabilitySignature(
    deliveryCapability,
    identity,
    authConfig,
  );
  if (claims.leaseExpiresAtMs <= Date.now()) {
    throw new ConnectError(
      'Sandbox callback delivery capability has expired',
      Code.FailedPrecondition,
    );
  }
  const admitted = await repository.getTurnDeliveryCapabilityClaims({
    turnId: identity.turnId,
    sandboxSessionId: identity.sandboxSessionId,
    agentId: identity.agentId,
    expectedDeliveryFence: deliveryFence(claims),
    expectedActiveGeneration: activeGeneration(claims),
  });
  if (!admitted) {
    throw new ConnectError(
      'Sandbox callback does not belong to the presented live turn delivery',
      Code.FailedPrecondition,
    );
  }
  return {
    claims,
    ...('conversationId' in admitted
      && typeof admitted.conversationId === 'string'
      ? { conversationId: admitted.conversationId }
      : {}),
  };
}

function deliveryFence(
  claims: Pick<TurnDeliveryCapabilityClaims, 'ownerId' | 'fenceToken'>,
): ExpectedTurnDeliveryFence {
  return {
    ownerId: claims.ownerId,
    fenceToken: claims.fenceToken,
  };
}

function activeGeneration(
  claims: Pick<
    TurnDeliveryCapabilityClaims,
    'restoreFenceToken' | 'containerId'
  >,
): SandboxSessionActiveGeneration {
  return {
    restoreFenceToken: claims.restoreFenceToken,
    containerId: claims.containerId ?? null,
  };
}

async function completeToolDedupOrThrow(
  repository: DatabaseRepository,
  requestId: string,
  result: string | null,
  error: string | null,
  phase: string,
  authority: {
    turnId: string;
    sandboxSessionId: string;
    agentId: string;
    expectedDeliveryFence: ExpectedTurnDeliveryFence;
    expectedActiveGeneration: SandboxSessionActiveGeneration;
  },
): Promise<void> {
  try {
    const completed = await repository.completeToolDedup(
      requestId,
      result,
      error,
      authority,
    );
    if (!completed) {
      throw new ConnectError(
        `Tool request ${requestId} delivery authority changed before ${phase}`,
        Code.FailedPrecondition,
      );
    }
  } catch (err) {
    if (err instanceof ConnectError) {
      throw err;
    }
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
  private approvalGate?: ToolApprovalGate;

  constructor(
    delegate?: ToolRegistryDelegate,
    makeToolContext?: ToolContextFactory,
    options: DefaultOrchestratorToolRegistryOptions = {},
  ) {
    this.delegate = delegate;
    this.makeToolContext = makeToolContext;
    this.approvalGate = options.approvalGate;
  }

  /** Install the approval gate after construction (the CLI builds the registry first). */
  setApprovalGate(gate: ToolApprovalGate): void {
    this.approvalGate = gate;
  }

  get(toolName: string, agentId?: string): OrchestratorToolHandler | undefined {
    const builtin = this.handlers.get(toolName);
    if (builtin) return builtin;

    if (this.delegate && this.makeToolContext) {
      const tool = this.delegate.getTool(toolName, agentId);
      if (tool) {
        const ctxFactory = this.makeToolContext;
        const run: OrchestratorToolHandler = async (args, ctx) => tool.handler(args, ctxFactory(ctx));
        if (!tool.requiresApproval) {
          return run;
        }
        if (this.approvalGate) {
          return this.approvalGate(toolName, run);
        }
        return async () => JSON.stringify({
          error: `${toolName} needs a person to approve each call, and approvals are not available here. The call was not made.`,
        });
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
  callbackAuthConfig?: GrpcCallbackAuthConfig;
  artifactRegistration?: ArtifactRegistrationService;
}

/**
 * Creates the handler implementations for OrchestratorService RPCs.
 *
 * Returns an object compatible with ConnectRouter.service() that maps each
 * RPC method name to its handler function.
 */
export function createOrchestratorServiceImpl(deps: OrchestratorServiceDeps) {
  const { eventBus, toolRegistry } = deps;
  const artifactRegistration = deps.artifactRegistration
    ?? (deps.repository
      ? new ArtifactRegistrationService({ repository: deps.repository, eventBus })
      : undefined);
  const callbackAuthConfig = deps.callbackAuthConfig
    ?? resolveGrpcCallbackAuthConfig(process.env, { warn: () => undefined });

  return {
    /**
     * RequestTool — sandbox calls this to execute an orchestrator-side tool.
     *
     * Looks up the tool handler by name, parses the JSON arguments, executes
     * the handler, and returns the result (or an error).
     */
    async requestTool(req: RequestToolRequest): Promise<RequestToolResponse> {
      try {
        const {
          turnId,
          sandboxSessionId,
          agentId,
          toolName,
          argsJson,
          requestId,
        } = req;

        if (!toolName) {
          throw new ConnectError('tool_name is required', Code.InvalidArgument);
        }
        if (deps.repository && !requestId) {
          throw new ConnectError('request_id is required', Code.InvalidArgument);
        }
        const liveDelivery = await admitLiveSandboxCallback(
          deps.repository,
          {
            turnId,
            sandboxSessionId,
            agentId,
          },
          req.deliveryCapability,
          callbackAuthConfig,
        );
        const callbackAuthority = liveDelivery
          ? {
            turnId,
            sandboxSessionId,
            agentId,
            expectedDeliveryFence: deliveryFence(liveDelivery.claims),
            expectedActiveGeneration: activeGeneration(liveDelivery.claims),
          }
          : undefined;

        let dedupInserted = false;
        if (requestId && deps.repository) {
          if (!callbackAuthority) {
            throw new ConnectError(
              'Sandbox callback does not belong to a live turn delivery',
              Code.FailedPrecondition,
            );
          }
          const admission = await deps.repository.tryAdmitToolRequest({
            requestId,
            turnId,
            sandboxSessionId,
            agentId,
            toolName,
            expectedDeliveryFence:
              callbackAuthority.expectedDeliveryFence,
            expectedActiveGeneration:
              callbackAuthority.expectedActiveGeneration,
          });
          if (admission === 'stale') {
            throw new ConnectError(
              'Sandbox callback delivery ownership changed before tool admission',
              Code.FailedPrecondition,
            );
          }
          if (admission === 'duplicate') {
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
            throw new ConnectError(
              `Tool request ${requestId} admission changed concurrently`,
              Code.Unavailable,
            );
          } else {
            if (admission === 'reclaimed') {
              // ADR 025 side-effect caveat: the executor admitted under the
              // previous fence died with its orchestrator before recording a
              // result, so the tool runs again under the successor.
              console.warn(
                `[OrchestratorService] re-executing tool ${toolName} request ${requestId} for turn ${turnId} `
                + 'after delivery takeover; its first execution never recorded a result',
              );
            }
            dedupInserted = true;
          }
        }

        const failToolRequest = async (error: string, phase: string): Promise<RequestToolResponse> => {
          if (dedupInserted && deps.repository) {
            if (!callbackAuthority) {
              throw new ConnectError(
                'Sandbox callback delivery authority is unavailable',
                Code.FailedPrecondition,
              );
            }
            await completeToolDedupOrThrow(
              deps.repository,
              requestId,
              null,
              error,
              phase,
              callbackAuthority,
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

        let result: string;
        try {
          result = await handler(args, {
            turnId,
            agentId,
            ...(sandboxSessionId ? { sandboxSessionId } : {}),
            ...(liveDelivery?.conversationId
              ? { conversationId: liveDelivery.conversationId }
              : {}),
            requestId,
            ...(liveDelivery
              ? {
                deliveryFence: deliveryFence(liveDelivery.claims),
                activeGeneration: activeGeneration(liveDelivery.claims),
              }
              : {}),
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return failToolRequest(errorMsg, 'failed execution');
        }

        if (dedupInserted && deps.repository) {
          if (!callbackAuthority) {
            throw new ConnectError(
              'Sandbox callback delivery authority is unavailable',
              Code.FailedPrecondition,
            );
          }
          await completeToolDedupOrThrow(
            deps.repository,
            requestId,
            result,
            null,
            'successful execution',
            callbackAuthority,
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
        const {
          turnId,
          sandboxSessionId,
          agentId,
          eventType,
          payloadJson,
        } = req;

        if (!eventType) {
          throw new ConnectError('event_type is required', Code.InvalidArgument);
        }
        const liveDelivery = await admitLiveSandboxCallback(
          deps.repository,
          {
            turnId,
            sandboxSessionId,
            agentId,
          },
          req.deliveryCapability,
          callbackAuthConfig,
        );

        let payload: Record<string, unknown> = {};
        if (payloadJson) {
          try {
            payload = JSON.parse(payloadJson) as Record<string, unknown>;
          } catch {
            throw new ConnectError('Invalid payload_json: failed to parse JSON', Code.InvalidArgument);
          }
        }

        if (
          typeof payload.agentId === 'string'
          && agentId
          && payload.agentId !== agentId
        ) {
          throw new ConnectError('payload agentId does not match agent_id', Code.InvalidArgument);
        }
        payload.turnId = turnId;
        payload.agentId = agentId;

        try {
          let didEmit: boolean;
          if (liveDelivery) {
            didEmit = await eventBus.emitCustomAsync(
              eventType,
              agentId,
              payload,
              {
                deliveryFence: deliveryFence(liveDelivery.claims),
                sandboxSessionId,
                activeGeneration: activeGeneration(liveDelivery.claims),
              },
            );
          } else {
            didEmit = await eventBus.emitCustomAsync(eventType, agentId, payload);
          }
          if (!didEmit) {
            throw new ConnectError(
              'Sandbox callback delivery ownership changed before event persistence',
              Code.FailedPrecondition,
            );
          }
        } catch (err) {
          if (err instanceof ConnectError) {
            throw err;
          }
          console.error(`[OrchestratorService] EmitEvent failed for ${eventType}:`, err);
          throw ensureConnectError(err);
        }

        return create(EmitEventResponseSchema, {});
      } catch (err) {
        throw ensureConnectError(err);
      }
    },

    async registerArtifact(req: RegisterArtifactRequest): Promise<RegisterArtifactResponse> {
      const {
        turnId,
        sandboxSessionId,
        agentId,
        artifact,
      } = req;
      if (!artifact || !artifact.name) {
        throw new ConnectError('artifact with name is required', Code.InvalidArgument);
      }
      if (!artifact.turnId || artifact.turnId !== turnId) {
        throw new ConnectError(
          'artifact turn_id must match request turn_id',
          Code.InvalidArgument,
        );
      }
      if (!artifact.agentId || artifact.agentId !== agentId) {
        throw new ConnectError(
          'artifact agent_id must match request agent_id',
          Code.InvalidArgument,
        );
      }
      let rawMetadata: unknown;
      if (artifact.metadataJson) {
        try {
          rawMetadata = JSON.parse(artifact.metadataJson) as unknown;
        } catch {
          throw new ConnectError('artifact metadata_json must be valid JSON', Code.InvalidArgument);
        }
      }
      const registrationFields = validateArtifactRegistrationFields({
        kind: artifact.kind || undefined,
        metadata: rawMetadata,
        sha256: artifact.sha256 || undefined,
      });
      if (!registrationFields.success) {
        throw new ConnectError(
          registrationFields.error,
          registrationFields.reason === 'metadata_too_large'
            ? Code.ResourceExhausted
            : Code.InvalidArgument,
        );
      }

      try {
        if (deps.repository && artifactRegistration) {
          const liveDelivery = await admitLiveSandboxCallback(
            deps.repository,
            {
              turnId,
              sandboxSessionId,
              agentId,
            },
            req.deliveryCapability,
            callbackAuthConfig,
          );
          if (!liveDelivery) {
            throw new ConnectError(
              'Sandbox callback does not belong to a live turn delivery',
              Code.FailedPrecondition,
            );
          }
          const row = await artifactRegistration.registerIfDeliveryOwned({
            id: artifact.id || undefined,
            agentId,
            turnId,
            name: artifact.name,
            mimeType: artifact.mimeType,
            sizeBytes: Number(artifact.sizeBytes),
            storageKey: artifact.storageKey,
            bucket: artifact.bucket,
            ...(registrationFields.kind ? { kind: registrationFields.kind } : {}),
            ...(registrationFields.metadata ? { metadata: registrationFields.metadata } : {}),
            ...(registrationFields.sha256 ? { sha256: registrationFields.sha256 } : {}),
          }, {
            turnId,
            sandboxSessionId,
            agentId,
            expectedDeliveryFence: deliveryFence(liveDelivery.claims),
            expectedActiveGeneration: activeGeneration(liveDelivery.claims),
          });
          if (!row) {
            throw new ConnectError(
              'Sandbox callback delivery ownership changed before artifact persistence',
              Code.FailedPrecondition,
            );
          }

          return create(RegisterArtifactResponseSchema, {
            artifactId: row.id,
          });
        }

        return create(RegisterArtifactResponseSchema, {
          artifactId: artifact.id || '',
          error: 'No repository configured for artifact storage',
        });
      } catch (err) {
        if (err instanceof ConnectError) {
          throw err;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        return create(RegisterArtifactResponseSchema, {
          artifactId: '',
          error: errorMsg,
        });
      }
    },

    async resolveArtifact(req: ResolveArtifactRequest): Promise<ResolveArtifactResponse> {
      const {
        artifactId,
        agentId: callerAgentId,
        turnId,
        sandboxSessionId,
      } = req;
      if (!artifactId) {
        throw new ConnectError('artifact_id is required', Code.InvalidArgument);
      }

      try {
        if (!deps.repository) {
          return create(ResolveArtifactResponseSchema, {
            error: 'No repository configured for artifact storage',
          });
        }

        await admitLiveSandboxCallback(
          deps.repository,
          {
            turnId,
            sandboxSessionId,
            agentId: callerAgentId,
          },
          req.deliveryCapability,
          callbackAuthConfig,
        );
        const row = await deps.repository.getArtifact(artifactId);
        // Ownership boundary: the callback-auth interceptor has already verified
        // that req.agentId is the true authenticated sandbox agent, so an
        // owned artifact belonging to a different agent must not be resolvable
        // across sandboxes. Unowned rows (agentId null — orphaned or operator
        // uploads) stay resolvable to an admitted sandbox delivery, and a
        // cross-agent hit is reported as not-found to avoid an existence oracle.
        if (!row || (row.agentId && row.agentId !== callerAgentId)) {
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
            kind: row.kind ?? '',
            sha256: row.sha256 ?? '',
          }),
        });
      } catch (err) {
        if (err instanceof ConnectError) {
          throw err;
        }
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

function describeJsonKind(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/**
 * Normalize the `payload` argument of the `emit-event` tool (ctx-n01m).
 *
 * Models sometimes serialize the payload themselves, so a string holding a
 * JSON object is parsed and accepted. Anything else that is not a plain
 * object is reported back to the caller instead of being replaced with `{}`,
 * which used to fire triggers with silently emptied payloads. An absent
 * payload carries no data and still means "empty payload".
 */
function normalizeEmitEventPayload(
  raw: unknown,
): { payload: Record<string, unknown> } | { error: string } {
  if (raw === undefined || raw === null) {
    return { payload: {} };
  }

  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {
        error: 'Error: emit-event requires "payload" to be a JSON object (got a string that is not valid JSON)',
      };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {
        error: `Error: emit-event requires "payload" to be a JSON object (got a JSON string encoding ${describeJsonKind(value)})`,
      };
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      error: `Error: emit-event requires "payload" to be a JSON object (got ${describeJsonKind(value)})`,
    };
  }

  return { payload: { ...(value as Record<string, unknown>) } };
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
    const normalized = normalizeEmitEventPayload(args.payload);
    if ('error' in normalized) {
      return normalized.error;
    }
    const payload = normalized.payload;

    payload.turnId = ctx.turnId;
    payload.conversationId = ctx.conversationId;
    payload.agentId = ctx.agentId;

    let didEmit: boolean;
    if (
      ctx.deliveryFence
      && ctx.sandboxSessionId
      && ctx.activeGeneration
    ) {
      didEmit = await eventBus.emitCustomAsync(
        eventType,
        ctx.agentId,
        payload,
        {
          deliveryFence: ctx.deliveryFence,
          sandboxSessionId: ctx.sandboxSessionId,
          activeGeneration: ctx.activeGeneration,
        },
      );
    } else if (ctx.deliveryFence) {
      didEmit = await eventBus.emitCustomAsync(
        eventType,
        ctx.agentId,
        payload,
        { deliveryFence: ctx.deliveryFence },
      );
    } else {
      didEmit = await eventBus.emitCustomAsync(eventType, ctx.agentId, payload);
    }
    if (!didEmit) {
      throw new ConnectError(
        'Sandbox callback delivery ownership changed before event persistence',
        Code.FailedPrecondition,
      );
    }

    return JSON.stringify({ ok: true, eventType });
  });

  if (interruptManager) {
    const approvalAuthority = async (ctx: ToolHandlerContext) => {
      const turn = repository ? await repository.getTurn(ctx.turnId) : undefined;
      const sandboxSessionId = ctx.sandboxSessionId ?? turn?.sandboxSessionId ?? undefined;
      const callbackAuthority = repository
        ? (
          ctx.deliveryFence
          && ctx.activeGeneration
          && sandboxSessionId
            ? {
              turnId: ctx.turnId,
              sandboxSessionId,
              agentId: ctx.agentId,
              expectedDeliveryFence: ctx.deliveryFence,
              expectedActiveGeneration: ctx.activeGeneration,
            }
            : undefined
        )
        : undefined;
      if (repository && !callbackAuthority) {
        throw new ConnectError(
          'Sandbox callback delivery authority is required for approval persistence',
          Code.FailedPrecondition,
        );
      }
      return {
        sandboxSessionId,
        conversationId: ctx.conversationId ?? turn?.conversationId ?? undefined,
        callbackAuthority,
      };
    };

    // Opt-in review tool: approve, approve with edits, or reject with a note.
    registry.set(EDIT_DOCUMENT_TOOL_NAME, async (args, ctx) => {
      const parsed = editDocumentInputSchema.safeParse(args);
      if (!parsed.success) {
        return JSON.stringify({ error: 'edit_document needs a title and the full content as strings' });
      }
      const authority = await approvalAuthority(ctx);
      const resolution = await interruptManager.waitForApproval(
        ctx.turnId,
        ctx.agentId,
        ctx.requestId,
        EDIT_DOCUMENT_TOOL_NAME,
        parsed.data,
        300_000,
        authority.sandboxSessionId,
        authority.conversationId,
        authority.callbackAuthority,
      );
      if (resolution.action === 'suspend') {
        return JSON.stringify({ approved: false });
      }
      return editDocumentResult(parsed.data.content, resolution);
    });

    registry.set('request-approval', async (args, ctx) => {
      const reason = typeof args.reason === 'string' ? args.reason : 'Tool requires approval';

      const turn = repository ? await repository.getTurn(ctx.turnId) : undefined;
      const sandboxSessionId = ctx.sandboxSessionId ?? turn?.sandboxSessionId ?? undefined;
      const callbackAuthority = repository
        ? (
          ctx.deliveryFence
          && ctx.activeGeneration
          && sandboxSessionId
            ? {
              turnId: ctx.turnId,
              sandboxSessionId,
              agentId: ctx.agentId,
              expectedDeliveryFence: ctx.deliveryFence,
              expectedActiveGeneration: ctx.activeGeneration,
            }
            : undefined
        )
        : undefined;
      if (repository && !callbackAuthority) {
        throw new ConnectError(
          'Sandbox callback delivery authority is required for approval persistence',
          Code.FailedPrecondition,
        );
      }

      const resolution = await interruptManager.waitForApproval(
        ctx.turnId,
        ctx.agentId,
        ctx.requestId,
        'request-approval',
        { ...args, reason },
        300_000,
        sandboxSessionId,
        ctx.conversationId ?? turn?.conversationId ?? undefined,
        callbackAuthority,
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
