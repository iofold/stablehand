import { describe, expect, it, vi } from 'vitest';

import type {
  InterruptResumeAttemptRow,
  TurnDeliveryLeaseRow,
} from '../../database/repository.js';
import { InterruptResumeAttemptWorker } from '../interrupt-resume-attempt-worker.js';

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
  overrides: Partial<TurnDeliveryLeaseRow> = {},
): TurnDeliveryLeaseRow {
  return {
    turnId: 'turn-1',
    ownerId: 'worker-a',
    fenceToken: 4,
    leaseExpiresAt: 61_000,
    updatedAt: 1_000,
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

describe('InterruptResumeAttemptWorker durable delivery admission', () => {
  it('claims before recovery, re-adopts the restored session, and executes with its delivery fence', async () => {
    const candidate = createAttempt();
    const claimedAttempt = createAttempt({
      sandboxSessionId: 'sandbox-restored',
      status: 'in_progress',
      attempts: 1,
    });
    const lease = createLease();
    const prepared = {
      kind: 'ready' as const,
      sandboxSessionId: 'sandbox-restored',
      turnId: 'turn-1',
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
    };
    const db = {
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
      claimInterruptResumeDelivery: vi.fn().mockResolvedValue({
        attempt: claimedAttempt,
        lease,
      }),
      renewTurnDeliveryLease: vi.fn().mockResolvedValue(lease),
      releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
      completeInterruptResumeDelivery: vi.fn().mockResolvedValue({
        ...claimedAttempt,
        status: 'completed',
      }),
      failInterruptResumeDelivery: vi.fn(),
      completeTerminalInterruptResumeAttempt: vi.fn(),
      failUnclaimedInterruptResumeAttempt: vi.fn(),
    };
    const sessionManager = {
      prepareInterruptContinuation: vi.fn().mockResolvedValue(prepared),
      executeInterruptContinuation: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new InterruptResumeAttemptWorker(
      {
        db: db as never,
        sessionManager: sessionManager as never,
        logger: createLogger(),
      },
      {
        ownerId: 'worker-a',
        leaseMs: 60_000,
        heartbeatMs: 20_000,
      },
    );

    worker.enqueue(candidate);
    await worker.drain();

    expect(sessionManager.prepareInterruptContinuation).toHaveBeenCalledWith(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
      {
        attemptId: 'attempt-1',
        fence: {
          ownerId: 'worker-a',
          fenceToken: 4,
        },
      },
    );
    expect(db.claimInterruptResumeDelivery).toHaveBeenNthCalledWith(1, {
      attemptId: 'attempt-1',
      sandboxSessionId: 'sandbox-old',
      ownerId: 'worker-a',
      leaseDurationMs: 60_000,
    });
    expect(db.claimInterruptResumeDelivery).toHaveBeenNthCalledWith(2, {
      attemptId: 'attempt-1',
      sandboxSessionId: 'sandbox-restored',
      ownerId: 'worker-a',
      leaseDurationMs: 60_000,
    });
    expect(sessionManager.executeInterruptContinuation).toHaveBeenCalledWith(
      prepared,
      'attempt-1',
      {
        ownerId: 'worker-a',
        fenceToken: 4,
      },
      expect.any(AbortSignal),
    );
    expect(db.completeInterruptResumeDelivery).toHaveBeenCalledWith(
      'attempt-1',
      {
        ownerId: 'worker-a',
        fenceToken: 4,
      },
    );
    expect(db.failInterruptResumeDelivery).not.toHaveBeenCalled();
  });

  it('restores a CHECKPOINTED HITL session before claiming continuation delivery', async () => {
    const candidate = createAttempt();
    const claimedAttempt = createAttempt({
      sandboxSessionId: 'sandbox-restored',
      status: 'in_progress',
      attempts: 1,
    });
    const lease = createLease();
    const prepared = {
      kind: 'ready' as const,
      sandboxSessionId: 'sandbox-restored',
      turnId: 'turn-1',
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
    };
    const db = {
      getTurn: vi.fn().mockResolvedValue({
        id: 'turn-1',
        status: 'running',
        completedAt: null,
      }),
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-old',
        status: 'CHECKPOINTED',
      }),
      getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
      claimInterruptResumeDelivery: vi.fn().mockResolvedValue({
        attempt: claimedAttempt,
        lease,
      }),
      renewTurnDeliveryLease: vi.fn().mockResolvedValue(lease),
      releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
      completeInterruptResumeDelivery: vi.fn().mockResolvedValue({
        ...claimedAttempt,
        status: 'completed',
      }),
      failInterruptResumeDelivery: vi.fn(),
      completeTerminalInterruptResumeAttempt: vi.fn(),
      failUnclaimedInterruptResumeAttempt: vi.fn(),
    };
    const sessionManager = {
      prepareInterruptContinuation: vi.fn().mockResolvedValue(prepared),
      executeInterruptContinuation: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    }, { ownerId: 'worker-a' });

    worker.enqueue(candidate);
    await worker.drain();

    expect(sessionManager.prepareInterruptContinuation).toHaveBeenCalledWith(
      'sandbox-old',
      'turn-1',
      'agent-1',
      'interrupt-1',
    );
    expect(db.claimInterruptResumeDelivery).toHaveBeenCalledOnce();
    expect(db.claimInterruptResumeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxSessionId: 'sandbox-restored' }),
    );
    expect(
      sessionManager.prepareInterruptContinuation.mock.invocationCallOrder[0],
    ).toBeLessThan(db.claimInterruptResumeDelivery.mock.invocationCallOrder[0]!);
  });

  it('recovers an in-progress attempt left bound to a TERMINATED sandbox before rebind', async () => {
    const candidate = createAttempt({ status: 'in_progress', attempts: 1 });
    const claimedAttempt = createAttempt({
      status: 'in_progress',
      attempts: 2,
      sandboxSessionId: 'sandbox-replacement',
    });
    const lease = createLease({
      ownerId: 'worker-b',
      fenceToken: 6,
    });
    const prepared = {
      kind: 'ready' as const,
      sandboxSessionId: 'sandbox-replacement',
      turnId: 'turn-1',
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
    };
    const db = {
      getTurn: vi.fn().mockResolvedValue({
        id: 'turn-1',
        status: 'running',
        completedAt: null,
      }),
      getSandboxSession: vi.fn().mockResolvedValue({
        id: 'sandbox-old',
        status: 'TERMINATED',
      }),
      getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
      claimInterruptResumeDelivery: vi.fn().mockResolvedValue({
        attempt: claimedAttempt,
        lease,
      }),
      renewTurnDeliveryLease: vi.fn().mockResolvedValue(lease),
      releaseTurnDeliveryLease: vi.fn().mockResolvedValue(true),
      completeInterruptResumeDelivery: vi.fn().mockResolvedValue({
        ...claimedAttempt,
        status: 'completed',
      }),
      failInterruptResumeDelivery: vi.fn(),
      completeTerminalInterruptResumeAttempt: vi.fn(),
      failUnclaimedInterruptResumeAttempt: vi.fn(),
    };
    const sessionManager = {
      prepareInterruptContinuation: vi.fn().mockResolvedValue(prepared),
      executeInterruptContinuation: vi.fn().mockResolvedValue(undefined),
    };
    const worker = new InterruptResumeAttemptWorker({
      db: db as never,
      sessionManager: sessionManager as never,
      logger: createLogger(),
    }, { ownerId: 'worker-b' });

    worker.enqueue(candidate);
    await worker.drain();

    expect(db.claimInterruptResumeDelivery).toHaveBeenCalledOnce();
    expect(db.claimInterruptResumeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: 'attempt-1',
        sandboxSessionId: 'sandbox-replacement',
        ownerId: 'worker-b',
      }),
    );
    expect(sessionManager.executeInterruptContinuation).toHaveBeenCalledWith(
      prepared,
      'attempt-1',
      { ownerId: 'worker-b', fenceToken: 6 },
      expect.any(AbortSignal),
    );
  });

  it('repairs an attempt without delivery when preparation finds the original turn terminal', async () => {
    const candidate = createAttempt({ status: 'in_progress' });
    const db = {
      getTurn: vi.fn().mockResolvedValue({
        id: 'turn-1',
        status: 'completed',
        completedAt: 2_000,
      }),
      getSandboxSession: vi.fn(),
      getRecoverableInterruptResumeAttempts: vi.fn().mockResolvedValue([]),
      claimInterruptResumeDelivery: vi.fn(),
      renewTurnDeliveryLease: vi.fn(),
      releaseTurnDeliveryLease: vi.fn(),
      completeInterruptResumeDelivery: vi.fn(),
      failInterruptResumeDelivery: vi.fn(),
      completeTerminalInterruptResumeAttempt: vi.fn().mockResolvedValue({
        ...candidate,
        status: 'completed',
      }),
      failUnclaimedInterruptResumeAttempt: vi.fn(),
    };
    const sessionManager = {
      prepareInterruptContinuation: vi.fn().mockResolvedValue({
        kind: 'terminal',
        turnId: 'turn-1',
      }),
      executeInterruptContinuation: vi.fn(),
    };
    const worker = new InterruptResumeAttemptWorker(
      {
        db: db as never,
        sessionManager: sessionManager as never,
        logger: createLogger(),
      },
      { ownerId: 'worker-a' },
    );

    worker.enqueue(candidate);
    await worker.drain();

    expect(db.completeTerminalInterruptResumeAttempt).toHaveBeenCalledWith(
      'attempt-1',
    );
    expect(db.claimInterruptResumeDelivery).not.toHaveBeenCalled();
    expect(sessionManager.executeInterruptContinuation).not.toHaveBeenCalled();
  });
});
