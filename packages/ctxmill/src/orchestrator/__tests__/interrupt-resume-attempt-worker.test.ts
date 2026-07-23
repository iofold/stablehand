import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  InterruptResumeAttemptRow,
  TurnDeliveryLeaseRow,
} from '../../database/repository.js';
import { InterruptResumeAttemptWorker } from '../interrupt-resume-attempt-worker.js';
import { SessionRestoreInProgressError } from '../session-manager/session-recovery-coordinator.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createAttempt(
  overrides: Partial<InterruptResumeAttemptRow> = {},
): InterruptResumeAttemptRow {
  return {
    id: 'attempt-1',
    interruptId: 'interrupt-1',
    turnId: 'turn-1',
    sandboxSessionId: 'sandbox-old',
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

function createLease(
  ownerId: string,
  fenceToken: number,
): TurnDeliveryLeaseRow {
  return {
    turnId: 'turn-1',
    ownerId,
    fenceToken,
    leaseExpiresAt: 61_000,
    updatedAt: 1_000,
  };
}

function createPrepared() {
  return {
    kind: 'ready' as const,
    sandboxSessionId: 'sandbox-restored',
    turnId: 'turn-1',
    agentId: 'agent-1',
    interruptId: 'interrupt-1',
    conversationId: 'conversation-1',
    mode: 'interactive' as const,
    taskDescription: 'continue',
    agentDef: {
      name: 'agent',
      harness: 'langgraph',
      harnessConfig: {},
      tools: [],
      systemPrompt: 'help',
    },
    pendingApprovals: [],
    fallbackToolCallId: 'approval-1',
    fallbackArgs: {},
    resolutionContent: 'APPROVED',
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createDb(overrides: Record<string, unknown> = {}) {
  const attempt = createAttempt({
    sandboxSessionId: 'sandbox-restored',
    status: 'in_progress',
    attempts: 1,
  });
  return {
    getTurn: vi.fn().mockResolvedValue({
      id: 'turn-1',
      status: 'running',
      completedAt: null,
    }),
    getSandboxSession: vi.fn().mockResolvedValue({
      id: 'sandbox-old',
      status: 'ACTIVE',
    }),
    getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
    claimInterruptResumeDelivery: vi.fn().mockImplementation(async (
      input: { ownerId: string },
    ) => ({
      attempt,
      lease: createLease(input.ownerId, 1),
    })),
    renewTurnDeliveryLease: vi.fn().mockImplementation(async (
      _turnId: string,
      ownerId: string,
      fenceToken: number,
    ) => createLease(ownerId, fenceToken)),
    releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
    completeInterruptResumeDelivery: vi.fn().mockResolvedValue({
      ...attempt,
      status: 'completed',
    }),
    failInterruptResumeDelivery: vi.fn().mockResolvedValue({
      ...attempt,
      status: 'failed',
    }),
    completeTerminalInterruptResumeAttempt: vi.fn(),
    failUnclaimedInterruptResumeAttempt: vi.fn(),
    ...overrides,
  };
}

function createSessionManager(overrides: Record<string, unknown> = {}) {
  return {
    prepareInterruptContinuation: vi.fn().mockResolvedValue(createPrepared()),
    executeInterruptContinuation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('InterruptResumeAttemptWorker fenced ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prevents duplicate local execution of the same durable attempt', async () => {
    const execution = createDeferred();
    const db = createDb();
    const sessionManager = createSessionManager({
      executeInterruptContinuation: vi.fn().mockImplementation(
        async () => execution.promise,
      ),
    });
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    }, { ownerId: 'worker-a' });

    worker.enqueue(createAttempt());
    worker.enqueue(createAttempt());
    await vi.waitFor(() => {
      expect(sessionManager.executeInterruptContinuation).toHaveBeenCalledOnce();
    });
    expect(db.claimInterruptResumeDelivery).toHaveBeenCalledTimes(2);

    execution.resolve();
    await worker.drain();
  });

  it('fails an invalid preparation only under its claimed delivery fence', async () => {
    const db = createDb({
      failInterruptResumeDelivery: vi.fn().mockResolvedValue({
        ...createAttempt(),
        status: 'failed',
      }),
    });
    const sessionManager = createSessionManager({
      prepareInterruptContinuation: vi.fn().mockRejectedValue(
        new Error('malformed checkpoint'),
      ),
    });
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    });

    worker.enqueue(createAttempt());
    await worker.drain();

    expect(db.failInterruptResumeDelivery).toHaveBeenCalledWith(
      'attempt-1',
      {
        ownerId: expect.any(String),
        fenceToken: 1,
      },
      'malformed checkpoint',
    );
    expect(db.failUnclaimedInterruptResumeAttempt).not.toHaveBeenCalled();
    expect(db.claimInterruptResumeDelivery).toHaveBeenCalledOnce();
  });

  it('defers a peer-owned restore without durably failing the attempt', async () => {
    const db = createDb();
    const sessionManager = createSessionManager({
      prepareInterruptContinuation: vi.fn().mockRejectedValue(
        new SessionRestoreInProgressError('sandbox-old'),
      ),
    });
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    }, { ownerId: 'worker-a' });

    worker.enqueue(createAttempt());
    await worker.drain();

    expect(db.failInterruptResumeDelivery).not.toHaveBeenCalled();
    expect(db.failUnclaimedInterruptResumeAttempt).not.toHaveBeenCalled();
    expect(db.releaseTurnDeliveryLease).toHaveBeenCalledWith(
      'turn-1',
      'worker-a',
      1,
    );
  });

  it('leaves successful delivery terminal-repairable when attempt completion persistence fails', async () => {
    const db = createDb({
      completeInterruptResumeDelivery: vi.fn().mockRejectedValue(
        new Error('database unavailable after terminal write'),
      ),
    });
    const sessionManager = createSessionManager();
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    }, { ownerId: 'worker-a' });

    worker.enqueue(createAttempt());
    await worker.drain();

    expect(sessionManager.executeInterruptContinuation).toHaveBeenCalledOnce();
    expect(db.failInterruptResumeDelivery).not.toHaveBeenCalled();
    expect(db.releaseTurnDeliveryLease).toHaveBeenCalledWith(
      'turn-1',
      'worker-a',
      1,
    );
  });

  it('aborts a delivery when renewal proves its fence is stale', async () => {
    vi.useFakeTimers();
    let now = 0;
    const wake = createDeferred();
    let deliveredSignal: AbortSignal | undefined;
    const db = createDb({
      renewTurnDeliveryLease: vi.fn().mockResolvedValue(undefined),
    });
    const sessionManager = createSessionManager({
      executeInterruptContinuation: vi.fn().mockImplementation(
        async (
          _prepared: unknown,
          _attemptId: string,
          _fence: unknown,
          signal: AbortSignal,
        ) => {
          deliveredSignal = signal;
          await wake.promise;
          signal.throwIfAborted();
        },
      ),
    });
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    }, {
      ownerId: 'worker-a',
      leaseMs: 100,
      heartbeatMs: 25,
      now: () => now,
    });

    worker.enqueue(createAttempt());
    await vi.waitFor(() => {
      expect(deliveredSignal).toBeDefined();
    });
    now = 25;
    await vi.advanceTimersByTimeAsync(25);
    expect(deliveredSignal?.aborted).toBe(true);

    wake.resolve();
    await worker.drain();
    expect(db.completeInterruptResumeDelivery).not.toHaveBeenCalled();
    expect(db.failInterruptResumeDelivery).not.toHaveBeenCalled();
  });

  it('allows B takeover while stale A wakes later with zero attempt finalization', async () => {
    vi.useFakeTimers();
    let now = 0;
    const wakeA = createDeferred();
    const completions: Array<{ ownerId: string; fenceToken: number }> = [];
    const db = createDb({
      claimInterruptResumeDelivery: vi.fn().mockImplementation(async (
        input: { ownerId: string },
      ) => ({
        attempt: createAttempt({
          sandboxSessionId: 'sandbox-restored',
          status: 'in_progress',
          attempts: input.ownerId === 'worker-a' ? 1 : 2,
        }),
        lease: createLease(
          input.ownerId,
          input.ownerId === 'worker-a' ? 1 : 2,
        ),
      })),
      renewTurnDeliveryLease: vi.fn().mockImplementation(async (
        _turnId: string,
        ownerId: string,
        fenceToken: number,
      ) => ownerId === 'worker-a'
        ? undefined
        : createLease(ownerId, fenceToken)),
      completeInterruptResumeDelivery: vi.fn().mockImplementation(
        async (_attemptId: string, fence: {
          ownerId: string;
          fenceToken: number;
        }) => {
          completions.push(fence);
          return {
            ...createAttempt(),
            status: 'completed',
          };
        },
      ),
    });
    const sessionA = createSessionManager({
      executeInterruptContinuation: vi.fn().mockImplementation(
        async (
          _prepared: unknown,
          _attemptId: string,
          _fence: unknown,
          signal: AbortSignal,
        ) => {
          await wakeA.promise;
          signal.throwIfAborted();
        },
      ),
    });
    const sessionB = createSessionManager();
    const workerA = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionA as never,
      logger: createLogger(),
    }, {
      ownerId: 'worker-a',
      leaseMs: 100,
      heartbeatMs: 25,
      now: () => now,
    });
    const workerB = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionB as never,
      logger: createLogger(),
    }, {
      ownerId: 'worker-b',
      leaseMs: 100,
      heartbeatMs: 25,
      now: () => now,
    });

    workerA.enqueue(createAttempt());
    await vi.waitFor(() => {
      expect(sessionA.executeInterruptContinuation).toHaveBeenCalledOnce();
    });
    now = 25;
    await vi.advanceTimersByTimeAsync(25);

    workerB.enqueue(createAttempt({ status: 'in_progress' }));
    await workerB.drain();
    expect(completions).toEqual([
      { ownerId: 'worker-b', fenceToken: 2 },
    ]);

    wakeA.resolve();
    await workerA.drain();
    expect(completions).toEqual([
      { ownerId: 'worker-b', fenceToken: 2 },
    ]);
    expect(db.failInterruptResumeDelivery).not.toHaveBeenCalled();
  });

  it('does not launch candidates returned after shutdown begins', async () => {
    const scan = createDeferred<InterruptResumeAttemptRow[]>();
    const db = createDb({
      getRecoverableInterruptResumeAttempts: vi.fn().mockImplementation(
        async () => scan.promise,
      ),
    });
    const sessionManager = createSessionManager();
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    });

    worker.start();
    await vi.waitFor(() => {
      expect(db.getRecoverableInterruptResumeAttempts).toHaveBeenCalledOnce();
    });
    const stopping = worker.stop();
    scan.resolve([createAttempt()]);
    await stopping;

    expect(sessionManager.prepareInterruptContinuation).not.toHaveBeenCalled();
    expect(db.claimInterruptResumeDelivery).not.toHaveBeenCalled();
  });
});
