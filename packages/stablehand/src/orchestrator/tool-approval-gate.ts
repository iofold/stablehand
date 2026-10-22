import type { EventMap, TypedEventBus } from '../events/bus.js';
import type { InterruptManager, InterruptResolution } from './interrupt.js';
import type {
  OrchestratorToolHandler,
  ToolHandlerContext,
} from './grpc/orchestrator-service.js';

/**
 * Orchestrator-side approval for tools that declare `requiresApproval`
 * (ctx-9gy9). Provider-backed tools (per-agent HTTP endpoints, MCP servers)
 * and project-local tools all run in the orchestrator, so this is the one
 * place every gated call passes through: the sandbox cannot skip it.
 *
 * The call pauses on a durable interrupt (the same row and approval card the
 * `request-approval` builtin uses). On approve the real handler runs; on
 * reject the model gets the rejection and the reviewer's note instead.
 */
export interface ToolApprovalGateDeps {
  interruptManager: Pick<InterruptManager, 'waitForApproval'>;
  eventBus?: Pick<TypedEventBus, 'emitAsync'>;
}

export type ToolApprovalGate = (
  toolName: string,
  handler: OrchestratorToolHandler,
) => OrchestratorToolHandler;

/**
 * The reviewer's note from a resolution: a plain string, or a `note` /
 * `reason` field on an object (the approval API takes either).
 */
export function resolutionNote(data: unknown): string | undefined {
  const candidate = typeof data === 'string'
    ? data
    : typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).note ?? (data as Record<string, unknown>).reason
      : undefined;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : undefined;
}

/** What the model receives when a reviewer rejects a gated call. */
export function rejectedToolCallResult(resolution: InterruptResolution): string {
  const note = resolutionNote(resolution.data);
  return JSON.stringify({
    error: `Tool call rejected: ${note ?? resolution.action}`,
    rejected: true,
    ...(note ? { note } : {}),
  });
}

function callbackAuthorityFor(ctx: ToolHandlerContext) {
  if (!ctx.sandboxSessionId || !ctx.deliveryFence || !ctx.activeGeneration) {
    throw new Error(
      'Sandbox callback delivery authority is required for approval persistence',
    );
  }
  return {
    turnId: ctx.turnId,
    sandboxSessionId: ctx.sandboxSessionId,
    agentId: ctx.agentId,
    expectedDeliveryFence: ctx.deliveryFence,
    expectedActiveGeneration: ctx.activeGeneration,
  };
}

export function createToolApprovalGate(deps: ToolApprovalGateDeps): ToolApprovalGate {
  return (toolName, handler) => async (args, ctx) => {
    const callbackAuthority = callbackAuthorityFor(ctx);

    if (deps.eventBus) {
      const started: EventMap['tool_call.started'] = {
        turnId: ctx.turnId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId ?? '',
        toolCallId: ctx.requestId,
        toolName,
        args,
        requiresApproval: true,
        timestamp: Date.now(),
      };
      const didEmit = await deps.eventBus.emitAsync('tool_call.started', started, {
        deliveryFence: callbackAuthority.expectedDeliveryFence,
        sandboxSessionId: callbackAuthority.sandboxSessionId,
        activeGeneration: callbackAuthority.expectedActiveGeneration,
      });
      if (!didEmit) {
        throw new Error(
          'Sandbox callback delivery ownership changed before approval event persistence',
        );
      }
    }

    const resolution = await deps.interruptManager.waitForApproval(
      ctx.turnId,
      ctx.agentId,
      ctx.requestId,
      toolName,
      args,
      undefined,
      callbackAuthority.sandboxSessionId,
      ctx.conversationId,
      callbackAuthority,
    );

    if (resolution.action !== 'approve') {
      return rejectedToolCallResult(resolution);
    }
    return handler(args, ctx);
  };
}
