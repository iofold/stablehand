import { randomUUID } from 'node:crypto';

import {
  MAX_INTERRUPT_RESUME_ATTEMPTS,
  type DatabaseRepository,
  type InterruptResumeAttemptRow,
  type TurnDeliveryLeaseRow,
} from '../database/repository.js';
import { unrefTimer } from '../util/timing.js';
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
  monitorClaimedTurnDeliveryLease,
  type TurnDeliveryLeaseGuard,
} from './turn-delivery-lease.js';

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

export type InterruptResumeAttemptStore = Pick<
  DatabaseRepository,
  | 'getTurn'
  | 'getSandboxSession'
  | 'getRecoverableInterruptResumeAttempts'
  | 'getExhaustedInterruptResumeAttempts'
  | 'claimInterruptResumeDelivery'
  | 'renewTurnDeliveryLease'
  | 'releaseTurnDeliveryLease'
  | 'completeInterruptResumeDelivery'
  | 'failInterruptResumeDelivery'
  | 'completeTerminalInterruptResumeAttempt'
  | 'failUnclaimedInterruptResumeAttempt'
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
   * ctx-eu6a: move budget-exhausted pending attempts to a terminal 'failed'
   * state with an operator-visible error, so they stop sitting invisibly at
   * the head of the recovery queue.
   */
  private async sweepExhausted(): Promise<void> {
    const exhausted = await this.deps.db.getExhaustedInterruptResumeAttempts(
      this.scanLimit,
    );
    for (const attempt of exhausted) {
      if (this.stopping) {
        return;
      }
      const failed = await this.deps.db.failUnclaimedInterruptResumeAttempt(
        attempt.id,
        `resume budget exhausted after ${attempt.attempts} attempts: ${attempt.lastError ?? 'unknown error'}`,
      );
      if (failed) {
        this.deps.logger.error(
          `${TAG} resume attempt ${attempt.id} (turn ${attempt.turnId}) exhausted `
          + `after ${attempt.attempts} attempts; marked failed: ${attempt.lastError ?? ''}`,
        );
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
    if (!attempt.sandboxSessionId) {
      const failed = await this.deps.db.failUnclaimedInterruptResumeAttempt(
        attempt.id,
        'Interrupt resume attempt has no sandbox session',
      );
      if (!failed) {
        this.deps.logger.warn(
          `${TAG} could not fail unclaimed attempt ${attempt.id}; ownership changed`,
        );
      }
      return;
    }

    // ctx-eu6a: retry budget. A row that has burned its attempts is terminated
    // here instead of re-driving an expensive restore forever (defense in depth
    // — the recovery scan already excludes it; this also covers enqueue()).
    if (attempt.attempts >= MAX_INTERRUPT_RESUME_ATTEMPTS) {
      const failed = await this.deps.db.failUnclaimedInterruptResumeAttempt(
        attempt.id,
        `resume budget exhausted after ${attempt.attempts} attempts: ${attempt.lastError ?? 'unknown error'}`,
      );
      if (failed) {
        this.deps.logger.error(
          `${TAG} resume attempt ${attempt.id} exhausted after ${attempt.attempts} attempts; marked failed`,
        );
      } else {
        this.deps.logger.warn(
          `${TAG} could not fail exhausted attempt ${attempt.id}; ownership changed`,
        );
      }
      return;
    }

    const originalTurn = await this.deps.db.getTurn(attempt.turnId);
    if (
      originalTurn
      && (
        originalTurn.completedAt !== null
        || (originalTurn.status !== 'queued' && originalTurn.status !== 'running')
      )
    ) {
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
