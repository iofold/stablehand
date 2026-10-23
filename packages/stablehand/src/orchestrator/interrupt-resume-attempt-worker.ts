import { randomUUID } from 'node:crypto';

import {
  MAX_INTERRUPT_RESUME_ATTEMPTS,
  type DatabaseRepository,
  type InterruptResumeAttemptRow,
  type TurnDeliveryLeaseRow,
} from '../database/repository.js';
import type { TypedEventBus } from '../events/bus.js';
import { unrefTimer } from '../util/timing.js';
import { InterruptContinuationUnrecoverableError } from './interrupt-continuation-error.js';
import type {
  PreparedInterruptContinuation,
  PreparedInterruptContinuationReady,
} from './session-manager/interrupt-resume-service.js';
import {
  SessionRecoveryConflictError,
  SessionRestoreInProgressError,
} from './session-manager/session-recovery-coordinator.js';
import type { TurnDeliveryFence } from './turn-delivery-fence.js';
import {
  acquireTurnDeliveryLease,
  monitorClaimedTurnDeliveryLease,
  type TurnDeliveryLeaseGuard,
} from './turn-delivery-lease.js';
import {
  APPROVAL_RESUME_SANDBOX_ENDED_RUN,
  TURN_ERROR_SANDBOX_ALREADY_ENDED_TURN,
  TurnFinalizer,
  isApprovalNotResumedError,
  turnErrorApprovalNotResumed,
} from './turn-finalizer.js';
import { repairConversationRunningToolCalls } from './turn-reconciler.js';

const TAG = '[InterruptResumeAttemptWorker]';
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_SCAN_LIMIT = 50;
/**
 * ctx-eu6a: cap on simultaneous in-flight resume attempts per scan, matching
 * the equivalently expensive idle-checkpoint bound
 * (MAX_CONCURRENT_IDLE_CHECKPOINTS). Overflow defers to the next poll rather
 * than restoring 50 sandboxes at once.
 */
const MAX_CONCURRENT_INTERRUPT_RESUMES = 3;
const MAX_LAST_ERROR_IN_COPY = 300;

export type InterruptResumeAttemptStore = Pick<
  DatabaseRepository,
  | 'getTurn'
  | 'getSandboxSession'
  | 'getRecoverableInterruptResumeAttempts'
  | 'getExhaustedInterruptResumeAttempts'
  | 'claimInterruptResumeDelivery'
  | 'claimTurnDeliveryLease'
  | 'renewTurnDeliveryLease'
  | 'releaseTurnDeliveryLease'
  | 'completeInterruptResumeDelivery'
  | 'failInterruptResumeDelivery'
  | 'completeTerminalInterruptResumeAttempt'
  | 'failUnclaimedInterruptResumeAttempt'
  | 'exhaustInterruptResumeAttempt'
>;

interface InterruptResumeSessionManager {
  prepareInterruptContinuation(
    sandboxSessionId: string,
    turnId: string,
    agentId: string,
    interruptId: string,
    recoveryAuthority?: {
      attemptId: string;
      fence: TurnDeliveryFence;
    },
  ): Promise<PreparedInterruptContinuation>;
  executeInterruptContinuation(
    prepared: PreparedInterruptContinuationReady,
    attemptId: string,
    fence: TurnDeliveryFence,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Closes a turn whose approval can no longer be applied (ctx-2jp0). Called
 * with the turn's delivery lease held; returns true when this call closed it.
 */
export interface ParkedTurnCloser {
  closeTurn(input: {
    turnId: string;
    error: string;
    fence: TurnDeliveryFence;
    signal: AbortSignal;
  }): Promise<boolean>;
}

/**
 * The production closer: repair the turn's running tool calls and finalize
 * it as an error through the single terminal writer (ADR 014), fenced by the
 * caller's delivery lease.
 */
export function createParkedTurnCloser(deps: {
  db: Pick<
    DatabaseRepository,
    | 'getTurn'
    | 'getMessages'
    | 'stageAssistantMessageUpdate'
    | 'finalizeTurnIfOpen'
    | 'finalizeTurnAndMarkLifecycleDraining'
  >;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  logger: Logger;
}): ParkedTurnCloser {
  const finalizer = new TurnFinalizer({
    db: deps.db,
    eventBus: deps.eventBus,
    logger: deps.logger,
  });
  return {
    async closeTurn({ turnId, error, fence, signal }) {
      const turn = await deps.db.getTurn(turnId);
      if (!turn || turn.completedAt !== null) {
        return false;
      }
      signal.throwIfAborted();
      if (turn.conversationId) {
        await repairConversationRunningToolCalls(deps, turn.conversationId, {
          turnId,
          deliveryFence: fence,
          signal,
        });
      }
      signal.throwIfAborted();
      const result = await finalizer.finalize({
        turnId,
        agentId: turn.agentId,
        conversationId: turn.conversationId ?? '',
        ...(turn.sandboxSessionId ? { sandboxSessionId: turn.sandboxSessionId } : {}),
        status: 'error',
        error,
        durationMs: Date.now() - turn.startedAt,
        expectedDeliveryFence: fence,
      });
      return result.finalized;
    },
  };
}

/** The turn error for an attempt that will not be retried again. */
export function interruptResumeGiveUpError(attempt: InterruptResumeAttemptRow): string {
  const lastError = attempt.lastError ?? '';
  if (isApprovalNotResumedError(lastError)) {
    return lastError;
  }
  if (lastError.includes(TURN_ERROR_SANDBOX_ALREADY_ENDED_TURN)) {
    return turnErrorApprovalNotResumed(APPROVAL_RESUME_SANDBOX_ENDED_RUN);
  }
  const detail = lastError.length > MAX_LAST_ERROR_IN_COPY
    ? `${lastError.slice(0, MAX_LAST_ERROR_IN_COPY)}...`
    : lastError;
  const attempts = Math.max(attempt.attempts, 1);
  return turnErrorApprovalNotResumed(
    `resuming it failed ${attempts} time${attempts === 1 ? '' : 's'}`
    + (detail ? ` (last error: ${detail})` : ''),
  );
}

function isTerminalTurn(turn: { completedAt: number | null; status: string }): boolean {
  return turn.completedAt !== null
    || (turn.status !== 'queued' && turn.status !== 'running');
}

interface InterruptResumeAttemptWorkerOptions {
  ownerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  scanLimit?: number;
  now?: () => number;
}

export class InterruptResumeAttemptWorker {
  private readonly ownerId: string;

  private readonly leaseMs: number;

  private readonly pollIntervalMs: number;

  private readonly heartbeatMs: number;

  private readonly scanLimit: number;

  private readonly now: () => number;

  private readonly runningAttemptIds = new Set<string>();

  private readonly inFlight = new Set<Promise<void>>();

  private pollTimer?: ReturnType<typeof setInterval>;

  private scanPromise?: Promise<void>;

  private started = false;

  private stopping = false;

  constructor(
    private readonly deps: {
      db: InterruptResumeAttemptStore;
      sessionManager: InterruptResumeSessionManager;
      logger: Logger;
      /** Closes turns whose resume is given up; without it they are only logged. */
      turnCloser?: ParkedTurnCloser;
    },
    options: InterruptResumeAttemptWorkerOptions = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this.now = options.now ?? Date.now;
    if (
      this.leaseMs <= 0
      || this.heartbeatMs <= 0
      || this.heartbeatMs >= this.leaseMs
    ) {
      throw new Error(
        'Interrupt resume heartbeat must be positive and shorter than its lease',
      );
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    void this.recoverNow();
    this.pollTimer = setInterval(() => {
      void this.recoverNow();
    }, this.pollIntervalMs);
    unrefTimer(this.pollTimer);
  }

  enqueue(attempt: InterruptResumeAttemptRow): void {
    if (this.stopping) {
      return;
    }
    this.launch(attempt);
  }

  async recoverNow(): Promise<void> {
    if (this.stopping) {
      return;
    }
    if (this.scanPromise) {
      return this.scanPromise;
    }

    const scan = (async () => {
      await this.sweepExhausted();
      if (this.stopping) {
        return;
      }
      const attempts = await this.deps.db.getRecoverableInterruptResumeAttempts(
        this.scanLimit,
      );
      if (this.stopping) {
        return;
      }
      for (const attempt of attempts) {
        if (this.stopping) {
          return;
        }
        // ctx-eu6a: bound the fan-out. Overflow rows are left for the next
        // poll rather than launching every eligible restore at once.
        if (this.inFlight.size >= MAX_CONCURRENT_INTERRUPT_RESUMES) {
          break;
        }
        this.launch(attempt);
      }
    })();
    this.scanPromise = scan;
    try {
      await scan;
    } catch (err) {
      this.deps.logger.error(`${TAG} recovery scan failed:`, err);
    } finally {
      if (this.scanPromise === scan) {
        this.scanPromise = undefined;
      }
    }
  }

  async drain(): Promise<void> {
    await this.scanPromise;
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.drain();
  }

  /**
   * ctx-eu6a, ctx-2jp0: attempts that will not be retried again are given
   * up, and their still-open turns are closed with clear copy, so an
   * approved turn never sits RUNNING after its resume stopped being retried.
   * Rows whose turn ended some other way are settled as completed.
   */
  private async sweepExhausted(): Promise<void> {
    const exhausted = await this.deps.db.getExhaustedInterruptResumeAttempts(
      this.scanLimit,
    );
    for (const attempt of exhausted) {
      if (this.stopping) {
        return;
      }
      if (this.runningAttemptIds.has(attempt.id)) {
        continue;
      }
      this.runningAttemptIds.add(attempt.id);
      try {
        const turn = await this.deps.db.getTurn(attempt.turnId);
        if (turn && isTerminalTurn(turn)) {
          await this.deps.db.completeTerminalInterruptResumeAttempt(attempt.id);
          continue;
        }
        await this.giveUp(attempt, interruptResumeGiveUpError(attempt));
      } catch (err) {
        this.deps.logger.error(
          `${TAG} could not give up exhausted attempt ${attempt.id} (turn ${attempt.turnId}):`,
          err,
        );
      } finally {
        this.runningAttemptIds.delete(attempt.id);
      }
    }
  }

  private launch(attempt: InterruptResumeAttemptRow): void {
    if (this.stopping || this.runningAttemptIds.has(attempt.id)) {
      return;
    }
    this.runningAttemptIds.add(attempt.id);
    const task = this.process(attempt)
      .catch((err) => {
        this.deps.logger.error(
          `${TAG} unexpected attempt failure for ${attempt.id}:`,
          err,
        );
      })
      .finally(() => {
        this.runningAttemptIds.delete(attempt.id);
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  private async process(attempt: InterruptResumeAttemptRow): Promise<void> {
    if (this.stopping) {
      return;
    }

    // A turn that already ended (cancelled, or closed by an earlier give-up)
    // needs no resume: settle the attempt, including a failed one, so the
    // recovery scan stops selecting it.
    const originalTurn = await this.deps.db.getTurn(attempt.turnId);
    if (originalTurn && isTerminalTurn(originalTurn)) {
      const repaired = await this.deps.db.completeTerminalInterruptResumeAttempt(
        attempt.id,
      );
      if (!repaired) {
        this.deps.logger.warn(
          `${TAG} terminal repair lost for attempt ${attempt.id}`,
        );
      }
      return;
    }

    if (!attempt.sandboxSessionId) {
      await this.giveUp(
        attempt,
        turnErrorApprovalNotResumed('it had no sandbox to continue in'),
      );
      return;
    }

    // ctx-eu6a: retry budget. A row that has burned its attempts is given up
    // here instead of re-driving an expensive restore forever (defense in
    // depth — the recovery scan already excludes it; this also covers
    // enqueue() and a person re-approving an exhausted card).
    if (attempt.attempts >= MAX_INTERRUPT_RESUME_ATTEMPTS) {
      await this.giveUp(attempt, interruptResumeGiveUpError(attempt));
      return;
    }

    let guard: TurnDeliveryLeaseGuard | undefined;
    try {
      let prepared: PreparedInterruptContinuation;
      const candidateSession = await this.deps.db.getSandboxSession(
        attempt.sandboxSessionId,
      );
      if (candidateSession?.status === 'ACTIVE') {
        const provisionalClaim = await this.deps.db.claimInterruptResumeDelivery({
          attemptId: attempt.id,
          sandboxSessionId: attempt.sandboxSessionId,
          ownerId: this.ownerId,
          leaseDurationMs: this.leaseMs,
        });
        if (!provisionalClaim) {
          return;
        }
        await this.assertConsistentClaim(
          attempt,
          provisionalClaim.lease,
          provisionalClaim.attempt.id,
        );
        guard = this.monitorLease(attempt.turnId, provisionalClaim.lease);
        try {
          prepared = await this.deps.sessionManager.prepareInterruptContinuation(
            attempt.sandboxSessionId,
            attempt.turnId,
            attempt.agentId,
            attempt.interruptId,
            {
              attemptId: attempt.id,
              fence: guard.fence,
            },
          );
        } catch (err) {
          await this.handlePreparationFailure(attempt, err, guard);
          return;
        }
      } else {
        // CHECKPOINTED/RESTORING/TERMINATED sessions cannot admit turn
        // delivery. Restore or join the durable session winner first; no
        // harness execution occurs until the claim below succeeds.
        try {
          prepared = await this.deps.sessionManager.prepareInterruptContinuation(
            attempt.sandboxSessionId,
            attempt.turnId,
            attempt.agentId,
            attempt.interruptId,
          );
        } catch (err) {
          await this.handlePreparationFailure(attempt, err);
          return;
        }
      }

      if (prepared.kind === 'terminal') {
        const repaired = await this.deps.db.completeTerminalInterruptResumeAttempt(
          attempt.id,
        );
        if (!repaired) {
          this.deps.logger.warn(
            `${TAG} terminal repair lost for attempt ${attempt.id}`,
          );
        }
        return;
      }
      if (this.stopping) {
        return;
      }

      // Dead ACTIVE recovery may invalidate a provisional delivery, while a
      // non-ACTIVE session is restored before it can admit delivery at all.
      // This claim adopts the authoritative restored/replacement session.
      const preparedClaim = await this.deps.db.claimInterruptResumeDelivery({
        attemptId: attempt.id,
        sandboxSessionId: prepared.sandboxSessionId,
        ownerId: this.ownerId,
        leaseDurationMs: this.leaseMs,
      });
      if (!preparedClaim) {
        return;
      }
      await this.assertConsistentClaim(
        attempt,
        preparedClaim.lease,
        preparedClaim.attempt.id,
      );
      if (!guard) {
        guard = this.monitorLease(attempt.turnId, preparedClaim.lease);
      } else if (
        preparedClaim.lease.ownerId !== guard.fence.ownerId
        || preparedClaim.lease.fenceToken !== guard.fence.fenceToken
      ) {
        await guard.release();
        guard = this.monitorLease(attempt.turnId, preparedClaim.lease);
      }
      const executionGuard = guard;
      let executionCompleted = false;
      try {
        await this.deps.sessionManager.executeInterruptContinuation(
          prepared,
          attempt.id,
          executionGuard.fence,
          executionGuard.signal,
        );
        executionCompleted = true;
        executionGuard.signal.throwIfAborted();
        const completed = await this.deps.db.completeInterruptResumeDelivery(
          attempt.id,
          executionGuard.fence,
        );
        if (!completed) {
          this.deps.logger.warn(
            `${TAG} completion fence lost for attempt ${attempt.id}`,
          );
        }
      } catch (err) {
        if (executionCompleted) {
          this.deps.logger.error(
            `${TAG} completion persistence failed for attempt ${attempt.id}; `
            + 'leaving terminal repair recoverable:',
            err,
          );
          return;
        }
        if (executionGuard.signal.aborted) {
          return;
        }
        if (err instanceof InterruptContinuationUnrecoverableError) {
          // ctx-2jp0: retrying would fail the same way; close the turn now.
          await this.giveUp(
            attempt,
            turnErrorApprovalNotResumed(err.reason),
            executionGuard,
          );
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        const failed = await this.deps.db.failInterruptResumeDelivery(
          attempt.id,
          executionGuard.fence,
          message,
        );
        if (!failed) {
          this.deps.logger.warn(
            `${TAG} failure fence lost for attempt ${attempt.id}`,
          );
        }
      }
    } finally {
      await guard?.release();
    }
  }

  /**
   * Stop retrying an approval's resume and close its turn with `error`
   * (ctx-2jp0). The attempt is marked failed at the retry budget first, so a
   * crash before the turn is closed leaves it for the next sweep to close.
   */
  private async giveUp(
    attempt: InterruptResumeAttemptRow,
    error: string,
    guard?: TurnDeliveryLeaseGuard,
  ): Promise<void> {
    const exhausted = await this.deps.db.exhaustInterruptResumeAttempt(
      attempt.id,
      error,
      guard?.fence,
    );
    if (!exhausted) {
      this.deps.logger.warn(
        `${TAG} could not stop retrying attempt ${attempt.id}; another worker owns it`,
      );
      return;
    }
    const alreadyGivenUp = attempt.status === 'failed'
      && attempt.attempts >= MAX_INTERRUPT_RESUME_ATTEMPTS
      && attempt.lastError === error;
    if (alreadyGivenUp) {
      this.deps.logger.info(
        `${TAG} closing turn ${attempt.turnId} of given-up resume attempt ${attempt.id}`,
      );
    } else {
      this.deps.logger.error(
        `${TAG} giving up resume attempt ${attempt.id} for turn ${attempt.turnId} `
        + `after ${exhausted.attempts} attempt(s): ${error}`,
      );
    }

    const closer = this.deps.turnCloser;
    if (!closer) {
      this.deps.logger.error(
        `${TAG} turn ${attempt.turnId} stays open: no turn closer is configured`,
      );
      return;
    }
    const lease = guard ?? await acquireTurnDeliveryLease(
      { db: this.deps.db, logger: this.deps.logger },
      attempt.turnId,
      {
        leaseMs: this.leaseMs,
        heartbeatMs: this.heartbeatMs,
        now: this.now,
        givenUpResumeAttemptId: attempt.id,
      },
    );
    if (!lease) {
      this.deps.logger.info(
        `${TAG} turn ${attempt.turnId} is owned elsewhere; the next sweep closes it`,
      );
      return;
    }
    try {
      const closed = await closer.closeTurn({
        turnId: attempt.turnId,
        error,
        fence: lease.fence,
        signal: lease.signal,
      });
      if (closed) {
        this.deps.logger.info(
          `${TAG} closed turn ${attempt.turnId} after giving up its approval resume`,
        );
      }
    } catch (err) {
      this.deps.logger.error(
        `${TAG} failed to close turn ${attempt.turnId}; the next sweep retries:`,
        err,
      );
    } finally {
      if (!guard) {
        await lease.release();
      }
    }
  }

  private monitorLease(
    turnId: string,
    lease: TurnDeliveryLeaseRow,
  ): TurnDeliveryLeaseGuard {
    return monitorClaimedTurnDeliveryLease(
      {
        db: this.deps.db,
        logger: this.deps.logger,
      },
      turnId,
      {
        ownerId: lease.ownerId,
        fenceToken: lease.fenceToken,
      },
      {
        leaseMs: this.leaseMs,
        heartbeatMs: this.heartbeatMs,
        now: this.now,
      },
    );
  }

  private async handlePreparationFailure(
    attempt: InterruptResumeAttemptRow,
    err: unknown,
    guard?: TurnDeliveryLeaseGuard,
  ): Promise<void> {
    if (guard?.signal.aborted) {
      return;
    }
    if (
      err instanceof SessionRecoveryConflictError
      || err instanceof SessionRestoreInProgressError
    ) {
      this.deps.logger.info(
        `${TAG} deferring attempt ${attempt.id} while sandbox recovery is owned elsewhere`,
      );
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const failed = guard
      ? await this.deps.db.failInterruptResumeDelivery(
          attempt.id,
          guard.fence,
          message,
        )
      : await this.deps.db.failUnclaimedInterruptResumeAttempt(
          attempt.id,
          message,
        );
    if (!failed) {
      this.deps.logger.warn(
        `${TAG} preparation failure could not update attempt ${attempt.id}; ownership changed`,
        err,
      );
    }
  }

  private async assertConsistentClaim(
    attempt: InterruptResumeAttemptRow,
    lease: TurnDeliveryLeaseRow,
    claimedAttemptId: string,
  ): Promise<void> {
    if (
      lease.turnId !== attempt.turnId
      || lease.ownerId !== this.ownerId
      || claimedAttemptId !== attempt.id
    ) {
      await this.deps.db.releaseTurnDeliveryLease(
        lease.turnId,
        lease.ownerId,
        lease.fenceToken,
      );
      throw new Error(
        `Interrupt resume claim ${attempt.id} returned inconsistent delivery ownership`,
      );
    }
  }
}
