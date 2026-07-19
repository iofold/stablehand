import type { InterruptResumeAttemptRow } from '../database/repository.js';
import { unrefTimer } from '../util/timing.js';

const TAG = '[InterruptResumeAttemptWorker]';
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_RENEWAL_RETRY_MS = 1_000;
const DEFAULT_MAX_RENEWAL_RETRIES = 3;
const DEFAULT_SCAN_LIMIT = 50;

export interface InterruptResumeAttemptStore {
  getRecoverableInterruptResumeAttempts(
    staleBefore: number,
    limit: number,
  ): Promise<InterruptResumeAttemptRow[]>;
  claimInterruptResumeAttempt(input: {
    id: string;
    expectedUpdatedAt: number;
    staleBefore: number;
    claimedAt: number;
  }): Promise<InterruptResumeAttemptRow | undefined>;
  renewInterruptResumeAttemptLease(
    id: string,
    expectedUpdatedAt: number,
    renewedAt: number,
  ): Promise<InterruptResumeAttemptRow | undefined>;
  completeInterruptResumeAttempt(
    id: string,
    expectedUpdatedAt: number,
    completedAt: number,
  ): Promise<InterruptResumeAttemptRow | undefined>;
  failInterruptResumeAttempt(
    id: string,
    expectedUpdatedAt: number,
    failedAt: number,
    error: string,
  ): Promise<InterruptResumeAttemptRow | undefined>;
}

interface InterruptResumeSessionManager {
  resumeWithInterruptResolution(
    sandboxSessionId: string,
    turnId: string,
    agentId: string,
    interruptId: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface InterruptResumeAttemptWorkerOptions {
  leaseMs?: number;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  renewalRetryMs?: number;
  maxRenewalRetries?: number;
  scanLimit?: number;
  now?: () => number;
}

export class InterruptResumeAttemptWorker {
  private readonly leaseMs: number;

  private readonly pollIntervalMs: number;

  private readonly heartbeatMs: number;

  private readonly renewalRetryMs: number;

  private readonly maxRenewalRetries: number;

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
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.renewalRetryMs = options.renewalRetryMs ?? DEFAULT_RENEWAL_RETRY_MS;
    this.maxRenewalRetries = options.maxRenewalRetries ?? DEFAULT_MAX_RENEWAL_RETRIES;
    this.scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this.now = options.now ?? Date.now;
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
      const staleBefore = this.now() - this.leaseMs;
      const attempts = await this.deps.db.getRecoverableInterruptResumeAttempts(
        staleBefore,
        this.scanLimit,
      );
      if (this.stopping) {
        return;
      }
      for (const attempt of attempts) {
        if (this.stopping) {
          return;
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

  private launch(attempt: InterruptResumeAttemptRow): void {
    if (this.stopping || this.runningAttemptIds.has(attempt.id)) {
      return;
    }
    this.runningAttemptIds.add(attempt.id);
    const task = this.process(attempt)
      .catch((err) => {
        this.deps.logger.error(`${TAG} unexpected attempt failure for ${attempt.id}:`, err);
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
    const now = this.now();
    const claimed = await this.deps.db.claimInterruptResumeAttempt({
      id: attempt.id,
      expectedUpdatedAt: attempt.updatedAt,
      staleBefore: now - this.leaseMs,
      claimedAt: Math.max(now, attempt.updatedAt + 1),
    });
    if (!claimed) {
      return;
    }
    if (this.stopping) {
      // Shutdown raced an already-issued claim. Do not start a new delivery;
      // the next worker can reclaim this lease once it becomes stale.
      return;
    }

    let leaseUpdatedAt = claimed.updatedAt;
    let leaseLost = false;
    let renewalFailures = 0;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    let leaseExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatStopped = false;
    const deliveryAbortController = new AbortController();

    const loseLease = (reason: string, cause?: unknown) => {
      if (leaseLost) {
        return;
      }
      leaseLost = true;
      if (leaseExpiryTimer) {
        clearTimeout(leaseExpiryTimer);
        leaseExpiryTimer = undefined;
      }
      const error = new Error(reason, cause === undefined ? undefined : { cause });
      deliveryAbortController.abort(error);
      this.deps.logger.warn(`${TAG} ${reason}`);
    };

    const armLeaseExpiryWatchdog = () => {
      if (heartbeatStopped || leaseLost) {
        return;
      }
      if (leaseExpiryTimer) {
        clearTimeout(leaseExpiryTimer);
      }
      const leaseRemainingMs = leaseUpdatedAt + this.leaseMs - this.now();
      if (leaseRemainingMs <= 0) {
        loseLease(`lease expired for attempt ${claimed.id}`);
        return;
      }
      leaseExpiryTimer = setTimeout(() => {
        leaseExpiryTimer = undefined;
        if (this.now() >= leaseUpdatedAt + this.leaseMs) {
          loseLease(`lease expired for attempt ${claimed.id}`);
          return;
        }
        armLeaseExpiryWatchdog();
      }, leaseRemainingMs);
      unrefTimer(leaseExpiryTimer);
    };

    const scheduleHeartbeat = (requestedDelayMs = this.heartbeatMs) => {
      if (heartbeatStopped || leaseLost) {
        return;
      }
      const leaseRemainingMs = leaseUpdatedAt + this.leaseMs - this.now();
      if (leaseRemainingMs <= 0) {
        loseLease(`lease expired for attempt ${claimed.id}`);
        return;
      }
      const delayMs = Math.max(0, Math.min(requestedDelayMs, leaseRemainingMs));
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        const heartbeat = (async () => {
          if (heartbeatStopped || leaseLost) {
            return;
          }
          if (this.now() >= leaseUpdatedAt + this.leaseMs) {
            loseLease(`lease expired for attempt ${claimed.id}`);
            return;
          }
          const renewedAt = Math.max(this.now(), leaseUpdatedAt + 1);
          try {
            const renewed = await this.deps.db.renewInterruptResumeAttemptLease(
              claimed.id,
              leaseUpdatedAt,
              renewedAt,
            );
            if (!renewed) {
              loseLease(`lease ownership lost for attempt ${claimed.id}`);
              return;
            }
            leaseUpdatedAt = renewed.updatedAt;
            renewalFailures = 0;
            armLeaseExpiryWatchdog();
          } catch (err) {
            renewalFailures++;
            const leaseRemainingAfterFailure = leaseUpdatedAt + this.leaseMs - this.now();
            if (
              leaseRemainingAfterFailure <= 0
              || renewalFailures > this.maxRenewalRetries
            ) {
              loseLease(
                `lease renewal failed for attempt ${claimed.id}; cancelling owned delivery`,
                err,
              );
              return;
            }
            this.deps.logger.warn(
              `${TAG} transient lease renewal failure for attempt ${claimed.id} `
              + `(retry ${renewalFailures}/${this.maxRenewalRetries}):`,
              err,
            );
            const retryDelay = this.renewalRetryMs * (2 ** (renewalFailures - 1));
            scheduleHeartbeat(retryDelay);
            return;
          }
          scheduleHeartbeat();
        })();
        heartbeatInFlight = heartbeat;
        void heartbeat.finally(() => {
          if (heartbeatInFlight === heartbeat) {
            heartbeatInFlight = undefined;
          }
        });
      }, delayMs);
      unrefTimer(heartbeatTimer);
    };

    const stopHeartbeat = async () => {
      heartbeatStopped = true;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      // A renewal transport call can hang forever. Keep the independent lease
      // watchdog armed while it is in flight and wait only until either the
      // renewal settles or ownership necessarily expires. This prevents a
      // successful delivery from stranding process shutdown/local recovery.
      const inFlightHeartbeat = heartbeatInFlight;
      if (inFlightHeartbeat && !leaseLost) {
        let onLeaseLost: (() => void) | undefined;
        const leaseLostPromise = new Promise<void>((resolve) => {
          if (deliveryAbortController.signal.aborted) {
            resolve();
            return;
          }
          onLeaseLost = () => resolve();
          deliveryAbortController.signal.addEventListener('abort', onLeaseLost, { once: true });
        });
        try {
          await Promise.race([inFlightHeartbeat, leaseLostPromise]);
        } finally {
          if (onLeaseLost) {
            deliveryAbortController.signal.removeEventListener('abort', onLeaseLost);
          }
        }
      }

      if (leaseExpiryTimer) {
        clearTimeout(leaseExpiryTimer);
        leaseExpiryTimer = undefined;
      }
    };

    if (!claimed.sandboxSessionId) {
      await this.deps.db.failInterruptResumeAttempt(
        claimed.id,
        leaseUpdatedAt,
        Math.max(this.now(), leaseUpdatedAt + 1),
        'Interrupt resume attempt has no sandbox session',
      );
      return;
    }

    armLeaseExpiryWatchdog();
    scheduleHeartbeat();
    let resumeCompleted = false;
    try {
      await this.deps.sessionManager.resumeWithInterruptResolution(
        claimed.sandboxSessionId,
        claimed.turnId,
        claimed.agentId,
        claimed.interruptId,
        deliveryAbortController.signal,
      );
      deliveryAbortController.signal.throwIfAborted();
      resumeCompleted = true;
      await stopHeartbeat();
      if (leaseLost) {
        return;
      }
      const completed = await this.deps.db.completeInterruptResumeAttempt(
        claimed.id,
        leaseUpdatedAt,
        Math.max(this.now(), leaseUpdatedAt + 1),
      );
      if (!completed) {
        this.deps.logger.warn(`${TAG} completion CAS lost for attempt ${claimed.id}`);
      }
    } catch (err) {
      await stopHeartbeat();
      if (resumeCompleted) {
        // Delivery returned successfully, so retry safety now depends on the
        // deterministic turn ID and sandbox boundary dedupe. Leave the lease
        // in progress; a stale-lease scan will finish it.
        this.deps.logger.error(
          `${TAG} completion persistence failed for attempt ${claimed.id}; leaving it recoverable:`,
          err,
        );
        return;
      }
      if (leaseLost) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.deps.db.failInterruptResumeAttempt(
        claimed.id,
        leaseUpdatedAt,
        Math.max(this.now(), leaseUpdatedAt + 1),
        message,
      );
      if (!failed) {
        this.deps.logger.warn(`${TAG} failure CAS lost for attempt ${claimed.id}`);
      }
    }
  }
}
