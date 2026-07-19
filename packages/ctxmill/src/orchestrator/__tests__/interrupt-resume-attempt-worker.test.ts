import { describe, expect, it, vi } from 'vitest';

import type { InterruptResumeAttemptRow } from '../../database/repository.js';
import { InterruptResumeAttemptWorker } from '../interrupt-resume-attempt-worker.js';

function createAttempt(overrides: Partial<InterruptResumeAttemptRow> = {}): InterruptResumeAttemptRow {
  return {
    id: 'attempt-1',
    interruptId: 'interrupt-1',
    turnId: 'turn-1',
    sandboxSessionId: 'sandbox-1',
    agentId: 'agent-1',
    status: 'in_progress',
    attempts: 1,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    ...overrides,
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createValueDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('InterruptResumeAttemptWorker', () => {
  it('prevents concurrent local re-entry while one process owns an attempt', async () => {
    const candidate = createAttempt({ status: 'pending' });
    const claimed = createAttempt({ updatedAt: 2_001 });
    const resume = createDeferred();
    const db = {
      getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
      claimInterruptResumeAttempt: vi.fn().mockResolvedValue(claimed),
      renewInterruptResumeAttemptLease: vi.fn(),
      completeInterruptResumeAttempt: vi.fn().mockResolvedValue(
        createAttempt({ status: 'completed', updatedAt: 3_001, completedAt: 3_001 }),
      ),
      failInterruptResumeAttempt: vi.fn(),
    };
    const sessionManager = {
      resumeWithInterruptResolution: vi.fn().mockImplementation(async () => resume.promise),
    };
    const worker = new InterruptResumeAttemptWorker(
      { db, sessionManager, logger: createLogger() },
      { now: () => 2_000, heartbeatMs: 60_000 },
    );

    worker.enqueue(candidate);
    worker.enqueue(candidate);
    await vi.waitFor(() => {
      expect(sessionManager.resumeWithInterruptResolution).toHaveBeenCalledTimes(1);
    });
    expect(db.claimInterruptResumeAttempt).toHaveBeenCalledTimes(1);

    resume.resolve();
    await worker.drain();
    expect(db.completeInterruptResumeAttempt).toHaveBeenCalledTimes(1);
  });

  it('leaves a crash-after-delivery completion failure lease-recoverable', async () => {
    const stale = createAttempt({ status: 'pending' });
    const firstClaim = createAttempt({ updatedAt: 2_001 });
    const firstDb = {
      getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
      claimInterruptResumeAttempt: vi.fn().mockResolvedValue(firstClaim),
      renewInterruptResumeAttemptLease: vi.fn(),
      completeInterruptResumeAttempt: vi.fn().mockRejectedValue(new Error('database disconnected')),
      failInterruptResumeAttempt: vi.fn(),
    };
    const firstResume = vi.fn().mockResolvedValue(undefined);
    const firstWorker = new InterruptResumeAttemptWorker(
      {
        db: firstDb,
        sessionManager: { resumeWithInterruptResolution: firstResume },
        logger: createLogger(),
      },
      { now: () => 2_000, heartbeatMs: 60_000 },
    );

    firstWorker.enqueue(stale);
    await firstWorker.drain();

    expect(firstResume).toHaveBeenCalledOnce();
    expect(firstDb.failInterruptResumeAttempt).not.toHaveBeenCalled();

    const reclaimed = createAttempt({ attempts: 2, updatedAt: 70_001 });
    const recoveryDb = {
      getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([firstClaim]),
      claimInterruptResumeAttempt: vi.fn().mockResolvedValue(reclaimed),
      renewInterruptResumeAttemptLease: vi.fn(),
      completeInterruptResumeAttempt: vi.fn().mockResolvedValue(
        createAttempt({ status: 'completed', attempts: 2, updatedAt: 70_002, completedAt: 70_002 }),
      ),
      failInterruptResumeAttempt: vi.fn(),
    };
    const recoveryResume = vi.fn().mockResolvedValue(undefined);
    const recoveryWorker = new InterruptResumeAttemptWorker(
      {
        db: recoveryDb,
        sessionManager: { resumeWithInterruptResolution: recoveryResume },
        logger: createLogger(),
      },
      { leaseMs: 60_000, now: () => 70_000, heartbeatMs: 60_000 },
    );

    await recoveryWorker.recoverNow();
    await recoveryWorker.drain();

    expect(recoveryDb.claimInterruptResumeAttempt).toHaveBeenCalledWith({
      id: 'attempt-1',
      expectedUpdatedAt: 2_001,
      staleBefore: 10_000,
      claimedAt: 70_000,
    });
    expect(recoveryResume).toHaveBeenCalledWith(
      'sandbox-1',
      'turn-1',
      'agent-1',
      'interrupt-1',
      expect.any(AbortSignal),
    );
    expect(recoveryDb.completeInterruptResumeAttempt).toHaveBeenCalledOnce();
  });

  it('renews ownership while a continuation delivery is still running', async () => {
    vi.useFakeTimers();
    try {
      let now = 2_000;
      const candidate = createAttempt({ status: 'pending' });
      const claimed = createAttempt({ updatedAt: 2_001 });
      const resume = createDeferred();
      const db = {
        getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
        claimInterruptResumeAttempt: vi.fn().mockResolvedValue(claimed),
        renewInterruptResumeAttemptLease: vi.fn().mockImplementation(async (
          _id: string,
          _expectedUpdatedAt: number,
          renewedAt: number,
        ) => createAttempt({ updatedAt: renewedAt })),
        completeInterruptResumeAttempt: vi.fn().mockImplementation(async (
          _id: string,
          _expectedUpdatedAt: number,
          completedAt: number,
        ) => createAttempt({ status: 'completed', updatedAt: completedAt, completedAt })),
        failInterruptResumeAttempt: vi.fn(),
      };
      const worker = new InterruptResumeAttemptWorker(
        {
          db,
          sessionManager: {
            resumeWithInterruptResolution: vi.fn().mockImplementation(async () => resume.promise),
          },
          logger: createLogger(),
        },
        { now: () => now, heartbeatMs: 10 },
      );

      worker.enqueue(candidate);
      await Promise.resolve();
      await Promise.resolve();

      now = 2_011;
      await vi.advanceTimersByTimeAsync(10);
      expect(db.renewInterruptResumeAttemptLease).toHaveBeenCalledWith(
        'attempt-1',
        2_001,
        2_011,
      );

      resume.resolve();
      await worker.drain();
      expect(db.completeInterruptResumeAttempt).toHaveBeenCalledWith(
        'attempt-1',
        2_011,
        2_012,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences a long delivery before a second worker reclaims after renewal transport failure', async () => {
    vi.useFakeTimers();
    let forceFirstDeliveryToSettle = () => {};
    try {
      let now = 2_000;
      let row = createAttempt({ status: 'pending', attempts: 0, updatedAt: 1_000 });
      let renewalCalls = 0;
      const db = {
        getRecoverableInterruptResumeAttempts: vi.fn(async (staleBefore: number) => {
          if (
            row.status === 'pending'
            || (row.status === 'in_progress' && row.updatedAt <= staleBefore)
          ) {
            return [{ ...row }];
          }
          return [];
        }),
        claimInterruptResumeAttempt: vi.fn(async (input: {
          id: string;
          expectedUpdatedAt: number;
          staleBefore: number;
          claimedAt: number;
        }) => {
          const claimable = row.id === input.id
            && row.updatedAt === input.expectedUpdatedAt
            && (
              row.status === 'pending'
              || (row.status === 'in_progress' && row.updatedAt <= input.staleBefore)
            );
          if (!claimable) {
            return undefined;
          }
          row = {
            ...row,
            status: 'in_progress',
            attempts: row.attempts + 1,
            updatedAt: input.claimedAt,
          };
          return { ...row };
        }),
        renewInterruptResumeAttemptLease: vi.fn(async () => {
          renewalCalls++;
          throw new Error('connection reset');
        }),
        completeInterruptResumeAttempt: vi.fn(async (
          id: string,
          expectedUpdatedAt: number,
          completedAt: number,
        ) => {
          if (row.id !== id || row.status !== 'in_progress' || row.updatedAt !== expectedUpdatedAt) {
            return undefined;
          }
          row = { ...row, status: 'completed', updatedAt: completedAt, completedAt };
          return { ...row };
        }),
        failInterruptResumeAttempt: vi.fn(),
      };

      let activeDeliveries = 0;
      let maxActiveDeliveries = 0;
      let firstSignal: AbortSignal | undefined;
      const firstDeliverySettled = createDeferred();
      const firstResume = vi.fn((
        _sessionId: string,
        _turnId: string,
        _agentId: string,
        _interruptId: string,
        signal?: AbortSignal,
      ) => {
        firstSignal = signal;
        activeDeliveries++;
        maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
        return new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) {
              return;
            }
            settled = true;
            activeDeliveries--;
            firstDeliverySettled.resolve();
            resolve();
          };
          forceFirstDeliveryToSettle = settle;
          if (signal?.aborted) {
            settle();
          } else {
            signal?.addEventListener('abort', settle, { once: true });
          }
        });
      });
      const secondResume = vi.fn(async () => {
        activeDeliveries++;
        maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
        activeDeliveries--;
      });

      const firstWorker = new InterruptResumeAttemptWorker(
        {
          db,
          sessionManager: { resumeWithInterruptResolution: firstResume },
          logger: createLogger(),
        },
        {
          leaseMs: 100,
          heartbeatMs: 30,
          renewalRetryMs: 30,
          maxRenewalRetries: 10,
          now: () => now,
        },
      );
      const secondWorker = new InterruptResumeAttemptWorker(
        {
          db,
          sessionManager: { resumeWithInterruptResolution: secondResume },
          logger: createLogger(),
        },
        {
          leaseMs: 100,
          heartbeatMs: 30,
          renewalRetryMs: 30,
          maxRenewalRetries: 10,
          now: () => now,
        },
      );

      firstWorker.enqueue({ ...row });
      await vi.waitFor(() => {
        expect(firstResume).toHaveBeenCalledOnce();
      });

      now = 2_030;
      await vi.advanceTimersByTimeAsync(30);
      now = 2_060;
      await vi.advanceTimersByTimeAsync(30);
      now = 2_090;
      await vi.advanceTimersByTimeAsync(30);
      expect(renewalCalls).toBe(3);
      expect(firstSignal?.aborted).toBe(false);

      now = 2_100;
      await vi.advanceTimersByTimeAsync(10);
      expect(firstSignal?.aborted).toBe(true);
      await firstDeliverySettled.promise;

      await secondWorker.recoverNow();
      await secondWorker.drain();
      await firstWorker.drain();

      expect(secondResume).toHaveBeenCalledOnce();
      expect(maxActiveDeliveries).toBe(1);
    } finally {
      forceFirstDeliveryToSettle();
      vi.useRealTimers();
    }
  });

  it('aborts continuation delivery immediately when renewal CAS loses ownership', async () => {
    vi.useFakeTimers();
    try {
      let now = 2_000;
      const deliverySettled = createDeferred();
      let deliveredSignal: AbortSignal | undefined;
      const db = {
        getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
        claimInterruptResumeAttempt: vi.fn().mockResolvedValue(
          createAttempt({ status: 'in_progress', updatedAt: 2_000 }),
        ),
        renewInterruptResumeAttemptLease: vi.fn().mockResolvedValue(undefined),
        completeInterruptResumeAttempt: vi.fn(),
        failInterruptResumeAttempt: vi.fn(),
      };
      const worker = new InterruptResumeAttemptWorker(
        {
          db,
          sessionManager: {
            resumeWithInterruptResolution: vi.fn((
              _sessionId: string,
              _turnId: string,
              _agentId: string,
              _interruptId: string,
              signal?: AbortSignal,
            ) => {
              deliveredSignal = signal;
              return new Promise<void>((resolve) => {
                signal?.addEventListener('abort', () => {
                  deliverySettled.resolve();
                  resolve();
                }, { once: true });
              });
            }),
          },
          logger: createLogger(),
        },
        { leaseMs: 100, heartbeatMs: 30, now: () => now },
      );

      worker.enqueue(createAttempt({ status: 'pending' }));
      await vi.waitFor(() => {
        expect(deliveredSignal).toBeDefined();
      });

      now = 2_030;
      await vi.advanceTimersByTimeAsync(30);
      await deliverySettled.promise;
      await worker.drain();

      expect(deliveredSignal?.aborted).toBe(true);
      expect(db.completeInterruptResumeAttempt).not.toHaveBeenCalled();
      expect(db.failInterruptResumeAttempt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts at lease expiry while a renewal transport call is hung', async () => {
    vi.useFakeTimers();
    const renewal = createValueDeferred<InterruptResumeAttemptRow | undefined>();
    let forceDeliveryToSettle = () => {};
    try {
      let now = 2_000;
      let deliveredSignal: AbortSignal | undefined;
      const deliverySettled = createDeferred();
      const db = {
        getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
        claimInterruptResumeAttempt: vi.fn().mockResolvedValue(
          createAttempt({ status: 'in_progress', updatedAt: 2_000 }),
        ),
        renewInterruptResumeAttemptLease: vi.fn().mockImplementation(() => renewal.promise),
        completeInterruptResumeAttempt: vi.fn(),
        failInterruptResumeAttempt: vi.fn(),
      };
      const worker = new InterruptResumeAttemptWorker(
        {
          db,
          sessionManager: {
            resumeWithInterruptResolution: vi.fn((
              _sessionId: string,
              _turnId: string,
              _agentId: string,
              _interruptId: string,
              signal?: AbortSignal,
            ) => {
              deliveredSignal = signal;
              return new Promise<void>((resolve) => {
                let settled = false;
                const settle = () => {
                  if (settled) {
                    return;
                  }
                  settled = true;
                  deliverySettled.resolve();
                  resolve();
                };
                forceDeliveryToSettle = settle;
                signal?.addEventListener('abort', settle, { once: true });
              });
            }),
          },
          logger: createLogger(),
        },
        { leaseMs: 100, heartbeatMs: 30, now: () => now },
      );

      worker.enqueue(createAttempt({ status: 'pending' }));
      await vi.waitFor(() => {
        expect(deliveredSignal).toBeDefined();
      });
      now = 2_030;
      await vi.advanceTimersByTimeAsync(30);
      expect(db.renewInterruptResumeAttemptLease).toHaveBeenCalledOnce();

      now = 2_100;
      await vi.advanceTimersByTimeAsync(70);
      expect(deliveredSignal?.aborted).toBe(true);
      await deliverySettled.promise;
    } finally {
      forceDeliveryToSettle();
      renewal.resolve(undefined);
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it('does not strand shutdown when delivery finishes while lease renewal is hung', async () => {
    vi.useFakeTimers();
    try {
      let now = 2_000;
      const renewal = createValueDeferred<InterruptResumeAttemptRow | undefined>();
      const delivery = createDeferred();
      let deliveredSignal: AbortSignal | undefined;
      const db = {
        getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
        claimInterruptResumeAttempt: vi.fn().mockResolvedValue(
          createAttempt({ status: 'in_progress', updatedAt: 2_000 }),
        ),
        renewInterruptResumeAttemptLease: vi.fn().mockImplementation(() => renewal.promise),
        completeInterruptResumeAttempt: vi.fn(),
        failInterruptResumeAttempt: vi.fn(),
      };
      const worker = new InterruptResumeAttemptWorker(
        {
          db,
          sessionManager: {
            resumeWithInterruptResolution: vi.fn((
              _sessionId: string,
              _turnId: string,
              _agentId: string,
              _interruptId: string,
              signal?: AbortSignal,
            ) => {
              deliveredSignal = signal;
              return delivery.promise;
            }),
          },
          logger: createLogger(),
        },
        { leaseMs: 100, heartbeatMs: 30, now: () => now },
      );

      worker.enqueue(createAttempt({ status: 'pending' }));
      await vi.waitFor(() => {
        expect(deliveredSignal).toBeDefined();
      });
      now = 2_030;
      await vi.advanceTimersByTimeAsync(30);
      expect(db.renewInterruptResumeAttemptLease).toHaveBeenCalledOnce();

      delivery.resolve();
      await Promise.resolve();
      const stopping = worker.stop();

      now = 2_100;
      await vi.advanceTimersByTimeAsync(70);
      await expect(stopping).resolves.toBeUndefined();

      expect(deliveredSignal?.aborted).toBe(true);
      expect(db.completeInterruptResumeAttempt).not.toHaveBeenCalled();
      expect(db.failInterruptResumeAttempt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not launch candidates returned by a scan after shutdown begins', async () => {
    const scan = createValueDeferred<InterruptResumeAttemptRow[]>();
    const db = {
      getRecoverableInterruptResumeAttempts: vi.fn().mockImplementation(() => scan.promise),
      claimInterruptResumeAttempt: vi.fn(),
      renewInterruptResumeAttemptLease: vi.fn(),
      completeInterruptResumeAttempt: vi.fn(),
      failInterruptResumeAttempt: vi.fn(),
    };
    const sessionManager = {
      resumeWithInterruptResolution: vi.fn(),
    };
    const worker = new InterruptResumeAttemptWorker(
      { db, sessionManager, logger: createLogger() },
      { heartbeatMs: 60_000 },
    );

    const recovery = worker.recoverNow();
    await vi.waitFor(() => {
      expect(db.getRecoverableInterruptResumeAttempts).toHaveBeenCalledOnce();
    });
    const stopping = worker.stop();
    scan.resolve([createAttempt({ status: 'pending' })]);
    await Promise.all([recovery, stopping]);

    expect(db.claimInterruptResumeAttempt).not.toHaveBeenCalled();
    expect(sessionManager.resumeWithInterruptResolution).not.toHaveBeenCalled();
  });

  it('keeps renewing an owned long delivery during shutdown and completes it before stopping', async () => {
    vi.useFakeTimers();
    try {
      let now = 2_000;
      const resume = createDeferred();
      const db = {
        getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
        claimInterruptResumeAttempt: vi.fn().mockResolvedValue(
          createAttempt({ status: 'in_progress', updatedAt: 2_000 }),
        ),
        renewInterruptResumeAttemptLease: vi.fn().mockImplementation(async (
          _id: string,
          _expectedUpdatedAt: number,
          renewedAt: number,
        ) => createAttempt({ status: 'in_progress', updatedAt: renewedAt })),
        completeInterruptResumeAttempt: vi.fn().mockImplementation(async (
          _id: string,
          _expectedUpdatedAt: number,
          completedAt: number,
        ) => createAttempt({ status: 'completed', updatedAt: completedAt, completedAt })),
        failInterruptResumeAttempt: vi.fn(),
      };
      const resumeWithInterruptResolution = vi.fn().mockImplementation(() => resume.promise);
      const worker = new InterruptResumeAttemptWorker(
        {
          db,
          sessionManager: {
            resumeWithInterruptResolution,
          },
          logger: createLogger(),
        },
        { leaseMs: 100, heartbeatMs: 30, now: () => now },
      );

      worker.enqueue(createAttempt({ status: 'pending' }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(resumeWithInterruptResolution).toHaveBeenCalledOnce();
      const stopping = worker.stop();

      now = 2_030;
      await vi.advanceTimersByTimeAsync(30);
      expect(db.renewInterruptResumeAttemptLease).toHaveBeenCalledOnce();

      resume.resolve();
      await stopping;

      expect(db.completeInterruptResumeAttempt).toHaveBeenCalledWith(
        'attempt-1',
        2_030,
        2_031,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
