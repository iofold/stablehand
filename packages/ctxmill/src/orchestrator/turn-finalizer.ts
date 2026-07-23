import { isTurnCancelled, type ApiTokenUsage } from '@ctxmill/shared';

import type {
  DatabaseRepository,
  SandboxSessionLifecycleFence,
} from '../database/repository.js';
import type { TypedEventBus } from '../events/bus.js';
import { turnCompletedPayload } from './turn-terminal-publisher.js';
import type { TurnDeliveryFence } from './turn-delivery-fence.js';
import { materializeTurnUsage } from './usage.js';

export type TurnFinalStatus = 'completed' | 'error' | 'cancelled';

// ── Error copy (ADR-014): distinct, cause-accurate messages ──────────────────

/** A restart stranded the turn; startup reconciliation closed it. */
export const TURN_ERROR_ORCHESTRATOR_RESTART =
  'Orchestrator restarted while this turn was in flight; the turn was closed by startup reconciliation. Retry the request.';

/** The sandbox connection dropped mid-turn (container stopped/removed OR idle timeout — cause not observable here). */
export function turnErrorSandboxConnectionLost(eventCount: number): string {
  return `Connection to sandbox lost during tool execution (${eventCount} events received before drop). `
    + 'Possible causes: the sandbox container stopped or was removed, or an external tool call exceeded '
    + 'the idle connection timeout. Please retry.';
}

/** The sandbox stream ended without an explicit TurnCompleted or TurnFailed frame. */
export function turnErrorSandboxStreamEndedWithoutCompletion(eventCount: number): string {
  return `Sandbox stream ended without a terminal frame after ${eventCount} event(s). `
    + 'The turn was closed as interrupted to avoid recording a false success. Please retry.';
}

/** A turn reached stream end while at least one tool call was still running. */
export const TURN_ERROR_RUNNING_TOOL_CALLS_AT_END =
  'Turn ended with running tool call(s); the turn was closed as interrupted instead of completed.';

/** A tool call was still running when its turn reached a terminal state. */
export const TOOL_CALL_INTERRUPTED_ERROR =
  'Tool call was still running when the turn ended and was closed without a result.';

export function deriveTurnStatus(input: { cancelled?: boolean; error?: string | null }): TurnFinalStatus {
  if (input.cancelled || isTurnCancelled(input.error)) {
    return 'cancelled';
  }
  return input.error ? 'error' : 'completed';
}

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

interface TurnFinalizerDeps {
  db: Pick<
    DatabaseRepository,
    | 'finalizeTurnIfOpen'
    | 'finalizeTurnAndMarkLifecycleDraining'
    | 'getTurn'
  >;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  logger?: Logger;
}

export interface FinalizeTurnParams {
  turnId: string;
  agentId: string;
  conversationId: string;
  status: TurnFinalStatus;
  error?: string;
  /** Sandbox session id to persist on the turn row (kept fresh by callers that track rebinds). */
  sandboxSessionId?: string;
  durationMs?: number;
  /** Harness-reported token usage from the turn's RUN_FINISHED event. */
  usage?: ApiTokenUsage;
  /** Require this live reconciliation owner/token for the terminal write. */
  expectedDeliveryFence?: TurnDeliveryFence;
  /**
   * Pre-reserved reset advanced atomically with the terminal turn write.
   * Requires expectedDeliveryFence and the exact bound sandbox session.
   */
  lifecycleReset?: {
    sandboxSessionId: string;
    fence: SandboxSessionLifecycleFence;
  };
  /**
   * Live-session cleanup after terminal publication is attempted. This callback
   * clears the controller/in-memory active marker only; TurnFinalizer is the
   * sole turn.completed publisher. Invoked exactly when this call finalized
   * the durable row, including when publication fails and startup must repair it.
   */
  settleSessionLifecycle?: (completedAt: number) => void | Promise<void>;
}

/**
 * The single writer of turn terminal state (ADR-014, ctx-nm3o). All code
 * paths that end a turn — live completion, startup reconciliation, run
 * startup failures, cancellation — go through finalize(). Idempotence is
 * enforced at the database (finalizeTurnIfOpen), so a second finalizer
 * losing the race cannot overwrite the first outcome. Canonical terminal
 * publication is awaited and independently idempotent, so a retry can repair
 * a row finalized before its RUN_ERROR/RUN_FINISHED transaction committed.
 * turn.completed status stays within completed|error|cancelled (frozen
 * webhook contract).
 */
export class TurnFinalizer {
  constructor(private readonly deps: TurnFinalizerDeps) {}

  async finalize(params: FinalizeTurnParams): Promise<{ finalized: boolean; published: boolean }> {
    const completedAt = Date.now();
    const existingTurn = params.usage
      ? await this.deps.db.getTurn(params.turnId)
      : undefined;
    const canonicalUsage = params.usage
      ? materializeTurnUsage(params.usage, {
        gatewayPending: existingTurn?.gatewayCorrelationId != null,
      })
      : null;
    const updates = {
      ...(params.sandboxSessionId ? { sandboxSessionId: params.sandboxSessionId } : {}),
      completedAt,
      error: params.error ?? null,
      status: params.status,
      ...(params.usage
        ? {
          inputTokens: params.usage.inputTokens,
          outputTokens: params.usage.outputTokens,
          totalTokens: params.usage.totalTokens,
          usage: canonicalUsage,
          ...(canonicalUsage?.cost.totalUsd != null
            ? { costUsd: canonicalUsage.cost.totalUsd }
            : {}),
        }
        : {}),
    };
    if (params.lifecycleReset && !params.expectedDeliveryFence) {
      throw new Error(
        `Turn ${params.turnId} lifecycle reset requires delivery ownership`,
      );
    }
    const finalized = params.lifecycleReset
      ? await this.deps.db.finalizeTurnAndMarkLifecycleDraining(
        params.turnId,
        updates,
        params.expectedDeliveryFence!,
        {
          sandboxSessionId: params.lifecycleReset.sandboxSessionId,
          ownerId: params.lifecycleReset.fence.ownerId,
          fenceToken: params.lifecycleReset.fence.fenceToken,
        },
      )
      : params.expectedDeliveryFence
        ? await this.deps.db.finalizeTurnIfOpen(
        params.turnId,
        updates,
        params.expectedDeliveryFence,
      )
        : await this.deps.db.finalizeTurnIfOpen(params.turnId, updates);

    try {
      if (finalized) {
        await this.deps.eventBus.emitAsync('turn.completed', {
          turnId: params.turnId,
          ...(params.sandboxSessionId ? { sandboxSessionId: params.sandboxSessionId } : {}),
          agentId: params.agentId,
          conversationId: params.conversationId,
          status: params.status,
          error: params.error,
          durationMs: params.durationMs ?? 0,
          usage: canonicalUsage,
          timestamp: completedAt,
        });
        return { finalized: true, published: true };
      }

      // A fenced finalizer that loses ownership must not repair or publish the
      // terminal state written (or still owned) by a newer reconciler.
      if (params.expectedDeliveryFence) {
        return { finalized: false, published: false };
      }

      const turn = await this.deps.db.getTurn(params.turnId);
      if (!turn) {
        throw new Error(`Cannot publish terminal state for missing turn ${params.turnId}`);
      }
      if (turn.terminalPublishedSeq != null) {
        if (!finalized) {
          this.deps.logger?.info(
            `[TurnFinalizer] turn ${params.turnId} is already finalized and canonically published`,
          );
        }
        return { finalized: false, published: false };
      }

      await this.deps.eventBus.emitAsync('turn.completed', turnCompletedPayload(turn));
      this.deps.logger?.info(
        `[TurnFinalizer] repaired canonical terminal publication for turn ${params.turnId}`,
      );
      return { finalized: false, published: true };
    } finally {
      if (finalized && params.settleSessionLifecycle) {
        try {
          await params.settleSessionLifecycle(completedAt);
        } catch (err) {
          this.deps.logger?.error(
            `[TurnFinalizer] session lifecycle settlement failed for turn ${params.turnId}:`,
            err,
          );
        }
      }
    }
  }
}
