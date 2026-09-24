/**
 * ctx-eu6a — interrupt resume worker queueing. Asserts the FIXED behaviour.
 *
 * (a) A recovery scan launches at most MAX_CONCURRENT_INTERRUPT_RESUMES=3
 *     restores at once (matching the idle-checkpoint bound); the rest defer to
 *     the next poll instead of restoring 50 sandboxes simultaneously.
 * (b) A row that has burned its retry budget is terminated (marked failed with
 *     an operator-visible error) rather than re-driven forever — the worker now
 *     reads attempt.attempts.
 *
 * The DB half — capped/backed-off scan that also re-drives 'failed' rows —
 * lives in tests/unit/interrupt-resume-retry-split.repro.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import type { InterruptResumeAttemptRow } from '../../database/repository.js';
import { InterruptResumeAttemptWorker } from '../interrupt-resume-attempt-worker.js';
import { SessionRestoreInProgressError } from '../session-manager/session-recovery-coordinator.js';

/** Number of eligible rows the scan returns. */
const SCAN_ROWS = 50;

/**
 * The bound this worker honours, matching MAX_CONCURRENT_IDLE_CHECKPOINTS for
 * the equivalently expensive idle-checkpoint work.
 */
const MAX_CONCURRENT_RESUMES = 3;

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAttempt(
  overrides: Partial<InterruptResumeAttemptRow> = {},
): InterruptResumeAttemptRow {
  return {
    id: 'attempt-1',
    interruptId: 'interrupt-1',
    turnId: 'turn-1',
    sandboxSessionId: 'sandbox-1',
    agentId: 'agent-1',
    status: 'pending',
    attempts: 0,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    ...overrides,
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * A store whose scan returns `rows`. The sandbox sessions are CHECKPOINTED, so
 * `process()` takes the restore-first branch: no provisional delivery claim,
 * straight into prepareInterruptContinuation (the expensive sandbox restore).
 */
function createDb(rows: InterruptResumeAttemptRow[]) {
  return {
    getTurn: vi.fn().mockResolvedValue({
      id: 'turn-1',
      status: 'running',
      completedAt: null,
    }),
    getSandboxSession: vi.fn().mockImplementation(async (id: string) => ({
      id,
      status: 'CHECKPOINTED',
    })),
    getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue(rows),
    getExhaustedInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
    claimInterruptResumeDelivery: vi.fn().mockResolvedValue(undefined),
    renewTurnDeliveryLease: vi.fn().mockResolvedValue(undefined),
    releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
    completeInterruptResumeDelivery: vi.fn().mockResolvedValue(undefined),
    failInterruptResumeDelivery: vi.fn().mockResolvedValue(undefined),
    completeTerminalInterruptResumeAttempt: vi.fn().mockResolvedValue(undefined),
    failUnclaimedInterruptResumeAttempt: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ctx-eu6a: interrupt resume attempt worker queueing', () => {
  it('(a) launches at most MAX_CONCURRENT_RESUMES restores per scan', async () => {
    const rows = Array.from({ length: SCAN_ROWS }, (_, index) => createAttempt({
      id: `attempt-${index}`,
      interruptId: `interrupt-${index}`,
      turnId: `turn-${index}`,
      sandboxSessionId: `sandbox-${index}`,
    }));
    const db = createDb(rows);

    let inFlight = 0;
    let peakInFlight = 0;
    const release = createDeferred();
    const sessionManager = {
      prepareInterruptContinuation: vi.fn().mockImplementation(async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          await release.promise;
        } finally {
          inFlight -= 1;
        }
        return { kind: 'terminal' as const };
      }),
      executeInterruptContinuation: vi.fn(),
    };

    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    });

    // The scan launches up to the cap and defers the rest; the launched
    // restores block, so once the cap is reached no more start.
    await worker.recoverNow();
    await vi.waitFor(() => {
      expect(sessionManager.prepareInterruptContinuation)
        .toHaveBeenCalledTimes(MAX_CONCURRENT_RESUMES);
    });

    const observedPeak = peakInFlight;
    release.resolve();
    await worker.drain();

    expect(observedPeak).toBe(MAX_CONCURRENT_RESUMES);
    // The overflow rows were NOT launched in this scan — they defer to the next
    // poll rather than restoring 50 sandboxes at once.
    expect(sessionManager.prepareInterruptContinuation.mock.calls.length)
      .toBeLessThanOrEqual(MAX_CONCURRENT_RESUMES);
  });

  it('(b) terminates a budget-exhausted attempt instead of re-driving it', async () => {
    const poisoned = createAttempt({
      attempts: 10_000,
      lastError: 'Maximum container limit (4) reached. Try again later.',
    });
    const db = createDb([poisoned]);

    const sessionManager = {
      prepareInterruptContinuation: vi.fn().mockRejectedValue(
        new SessionRestoreInProgressError('sandbox-1'),
      ),
      executeInterruptContinuation: vi.fn(),
    };

    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    });

    const scans = 25;
    for (let scan = 0; scan < scans; scan += 1) {
      await worker.recoverNow();
      await worker.drain();
    }

    // The worker reads attempt.attempts and never spends an expensive restore
    // on a row past its budget.
    expect(sessionManager.prepareInterruptContinuation).not.toHaveBeenCalled();
    // It records the exhaustion durably (marked failed) so the row stops being
    // eligible and becomes operator-visible.
    expect(db.failUnclaimedInterruptResumeAttempt).toHaveBeenCalledWith(
      poisoned.id,
      expect.stringContaining('resume budget exhausted'),
    );
  });
});
