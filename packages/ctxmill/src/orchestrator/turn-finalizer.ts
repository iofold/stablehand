import { isSessionCancelled } from '@ctxmill/shared';

import type { DatabaseRepository } from '../database/repository.js';
import type { TypedEventBus } from '../events/bus.js';

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
  if (input.cancelled || isSessionCancelled(input.error)) {
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
  db: Pick<DatabaseRepository, 'finalizeTurnIfOpen'>;
  eventBus?: Pick<TypedEventBus, 'emit'> | null;
  logger?: Logger;
}

export interface FinalizeTurnParams {
  turnId: string;
  agentId: string;
  conversationId: string;
  status: TurnFinalStatus;
  error?: string;
  /** Sandbox session id to persist on the turn row (kept fresh by callers that track rebinds). */
  sessionId?: string;
  durationMs?: number;
  /**
   * Override for the turn.completed signal — used by the live path to route
   * through SandboxSessionManager.completeTurn (which also drains queues and
   * schedules idle timeouts). When absent, the finalizer emits turn.completed
   * on the bus directly. Only invoked when this call actually finalized the turn.
   */
  emitCompletion?: (completedAt: number) => void;
}

/**
 * The single writer of turn terminal state (ADR-014, ctx-nm3o). All code
 * paths that end a turn — live completion, startup reconciliation, run
 * startup failures, cancellation — go through finalize(). Idempotence is
 * enforced at the database (finalizeTurnIfOpen), so a second finalizer
 * losing the race cannot overwrite the first outcome or double-signal
 * turn.completed. turn.completed status stays within completed|error|cancelled
 * (frozen webhook contract).
 */
export class TurnFinalizer {
  constructor(private readonly deps: TurnFinalizerDeps) {}

  async finalize(params: FinalizeTurnParams): Promise<{ finalized: boolean }> {
    const completedAt = Date.now();
    const finalized = await this.deps.db.finalizeTurnIfOpen(params.turnId, {
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      completedAt,
      error: params.error ?? null,
      status: params.status,
    });

    if (!finalized) {
      this.deps.logger?.info(
        `[TurnFinalizer] turn ${params.turnId} already terminal; skipping ${params.status} finalize`,
      );
      return { finalized: false };
    }

    try {
      if (params.emitCompletion) {
        params.emitCompletion(completedAt);
      } else {
        this.deps.eventBus?.emit('turn.completed', {
          turnId: params.turnId,
          sessionId: params.sessionId ?? '',
          agentId: params.agentId,
          conversationId: params.conversationId,
          status: params.status,
          error: params.error,
          durationMs: params.durationMs ?? 0,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      this.deps.logger?.error(
        `[TurnFinalizer] turn.completed signal failed for turn ${params.turnId} (turn is finalized):`,
        err,
      );
    }

    return { finalized: true };
  }
}
