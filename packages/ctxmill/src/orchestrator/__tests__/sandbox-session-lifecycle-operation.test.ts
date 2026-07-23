import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  SandboxSessionLifecycleOperationRow,
} from '../../database/repository.js';
import { acquireSandboxSessionLifecycleOperation } from '../sandbox-session-lifecycle-operation.js';

function claimedLifecycleOperation(
  overrides: Partial<SandboxSessionLifecycleOperationRow> = {},
): SandboxSessionLifecycleOperationRow {
  return {
    sandboxSessionId: 'sandbox-session-1',
    operation: 'checkpoint',
    operationId: 'logical-checkpoint-1',
    phase: 'reserved',
    ownerId: 'replica-a',
    fenceToken: 3,
    allowedTurnId: null,
    allowedDeliveryOwnerId: null,
    allowedDeliveryFenceToken: null,
    allowedInterruptResumeAttemptId: null,
    leaseExpiresAt: 100,
    updatedAt: 0,
    ...overrides,
  };
}

describe('sandbox session lifecycle operation guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the exact expected ACTIVE generation including a null container binding', async () => {
    const db = {
      claimSandboxSessionLifecycleOperation: vi.fn(async (input: {
        sandboxSessionId: string;
        operation: 'checkpoint';
        ownerId: string;
        leaseDurationMs: number;
      }) => ({
        sandboxSessionId: input.sandboxSessionId,
        operation: input.operation,
        operationId: 'logical-checkpoint-generation',
        phase: 'reserved' as const,
        ownerId: input.ownerId,
        fenceToken: 1,
        allowedTurnId: null,
        allowedDeliveryOwnerId: null,
        allowedDeliveryFenceToken: null,
        allowedInterruptResumeAttemptId: null,
        leaseExpiresAt: 60_000,
        updatedAt: 0,
      })),
      renewSandboxSessionLifecycleOperation: vi.fn(async () => undefined),
      markSandboxSessionLifecycleOperationExecuting: vi.fn(async () => true),
      cancelSandboxSessionLifecycleOperation: vi.fn(async () => true),
    };
    const options = {
      ownerId: 'replica-generation',
      expectedActiveGeneration: {
        restoreFenceToken: 0,
        containerId: null,
      },
    };

    const guard = await acquireSandboxSessionLifecycleOperation(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-generation',
      'checkpoint',
      options,
    );

    expect(guard).toBeDefined();
    expect(db.claimSandboxSessionLifecycleOperation).toHaveBeenCalledWith({
      sandboxSessionId: 'sandbox-session-generation',
      operation: 'checkpoint',
      ownerId: 'replica-generation',
      leaseDurationMs: 60_000,
      expectedActiveGeneration: {
        restoreFenceToken: 0,
        containerId: null,
      },
    });
    await guard!.stop();
  });

  it('does not extend the initial lifecycle lease by a delayed claim response', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    let resolveClaim:
      ((operation: SandboxSessionLifecycleOperationRow) => void)
      | undefined;
    const db = {
      claimSandboxSessionLifecycleOperation: vi.fn(
        () => new Promise<SandboxSessionLifecycleOperationRow>((resolve) => {
          resolveClaim = resolve;
        }),
      ),
      renewSandboxSessionLifecycleOperation: vi.fn(async () => undefined),
      markSandboxSessionLifecycleOperationExecuting: vi.fn(async () => true),
      cancelSandboxSessionLifecycleOperation: vi.fn(async () => true),
    };

    const acquiring = acquireSandboxSessionLifecycleOperation(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      'checkpoint',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: null,
        },
      },
    );
    await Promise.resolve();
    localNow = 100;
    resolveClaim!(claimedLifecycleOperation());

    const guard = await acquiring;
    expect(guard).toBeDefined();
    expect(guard!.signal.aborted).toBe(true);
    await expect(guard!.markExecuting()).resolves.toBe(false);
    expect(
      db.markSandboxSessionLifecycleOperationExecuting,
    ).not.toHaveBeenCalled();
    await guard!.stop();
  });

  it('expires a renewed lifecycle lease from renewal request start', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    let resolveRenewal:
      ((operation: SandboxSessionLifecycleOperationRow) => void)
      | undefined;
    const db = {
      claimSandboxSessionLifecycleOperation: vi.fn(
        async () => claimedLifecycleOperation(),
      ),
      renewSandboxSessionLifecycleOperation: vi.fn(
        () => new Promise<SandboxSessionLifecycleOperationRow>((resolve) => {
          resolveRenewal = resolve;
        }),
      ),
      markSandboxSessionLifecycleOperationExecuting: vi.fn(async () => true),
      cancelSandboxSessionLifecycleOperation: vi.fn(async () => true),
    };
    const guard = await acquireSandboxSessionLifecycleOperation(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      'checkpoint',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: null,
        },
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    localNow = 90;
    resolveRenewal!(claimedLifecycleOperation({ leaseExpiresAt: 125 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(guard!.signal.aborted).toBe(false);

    localNow = 125;
    await vi.advanceTimersByTimeAsync(35);
    expect(guard!.signal.aborted).toBe(true);
    await guard!.stop();
  });

  it('rejects a lifecycle renewal response that consumed its local lease', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    let resolveRenewal:
      ((operation: SandboxSessionLifecycleOperationRow) => void)
      | undefined;
    const db = {
      claimSandboxSessionLifecycleOperation: vi.fn(
        async () => claimedLifecycleOperation(),
      ),
      renewSandboxSessionLifecycleOperation: vi.fn(
        () => new Promise<SandboxSessionLifecycleOperationRow>((resolve) => {
          resolveRenewal = resolve;
        }),
      ),
      markSandboxSessionLifecycleOperationExecuting: vi.fn(async () => true),
      cancelSandboxSessionLifecycleOperation: vi.fn(async () => true),
    };
    const guard = await acquireSandboxSessionLifecycleOperation(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      'checkpoint',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: null,
        },
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    localNow = 125;
    resolveRenewal!(claimedLifecycleOperation({ leaseExpiresAt: 125 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(guard!.signal.aborted).toBe(true);
    await expect(guard!.cancel()).resolves.toBe(false);
    expect(db.cancelSandboxSessionLifecycleOperation).not.toHaveBeenCalled();
    await guard!.stop();
  });

  it('bounds stop by local lease expiry when renewal never settles', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = {
      claimSandboxSessionLifecycleOperation: vi.fn(async (input: {
        sandboxSessionId: string;
        operation: 'checkpoint';
        ownerId: string;
        leaseDurationMs: number;
      }) => ({
        sandboxSessionId: input.sandboxSessionId,
        operation: input.operation,
        operationId: 'logical-checkpoint-1',
        phase: 'reserved' as const,
        ownerId: input.ownerId,
        fenceToken: 3,
        allowedTurnId: null,
        allowedDeliveryOwnerId: null,
        allowedDeliveryFenceToken: null,
        leaseExpiresAt: 100,
        updatedAt: 0,
      })),
      renewSandboxSessionLifecycleOperation: vi.fn(
        () => new Promise<undefined>(() => undefined),
      ),
      markSandboxSessionLifecycleOperationExecuting: vi.fn(async () => true),
      cancelSandboxSessionLifecycleOperation: vi.fn(async () => true),
    };
    const guard = await acquireSandboxSessionLifecycleOperation(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      'checkpoint',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: null,
        },
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    expect(
      db.renewSandboxSessionLifecycleOperation,
    ).toHaveBeenCalledOnce();

    let stopped = false;
    const stop = guard!.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    localNow = 100;
    await vi.advanceTimersByTimeAsync(75);
    await stop;

    expect(guard!.signal.aborted).toBe(true);
    expect(guard!.signal.reason).toEqual(expect.objectContaining({
      message: 'lifecycle lease expired for sandbox session sandbox-session-1',
    }));
  });

  it('bounds markExecuting by local lease expiry when renewal never settles', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = {
      claimSandboxSessionLifecycleOperation: vi.fn(async (input: {
        sandboxSessionId: string;
        operation: 'checkpoint';
        ownerId: string;
        leaseDurationMs: number;
      }) => ({
        sandboxSessionId: input.sandboxSessionId,
        operation: input.operation,
        operationId: 'logical-checkpoint-1',
        phase: 'reserved' as const,
        ownerId: input.ownerId,
        fenceToken: 3,
        allowedTurnId: null,
        allowedDeliveryOwnerId: null,
        allowedDeliveryFenceToken: null,
        leaseExpiresAt: 100,
        updatedAt: 0,
      })),
      renewSandboxSessionLifecycleOperation: vi.fn(
        () => new Promise<undefined>(() => undefined),
      ),
      markSandboxSessionLifecycleOperationExecuting: vi.fn(async () => true),
      cancelSandboxSessionLifecycleOperation: vi.fn(async () => true),
    };
    const guard = await acquireSandboxSessionLifecycleOperation(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      'checkpoint',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: null,
        },
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    const marked = guard!.markExecuting();

    localNow = 100;
    await vi.advanceTimersByTimeAsync(75);

    await expect(marked).resolves.toBe(false);
    expect(
      db.markSandboxSessionLifecycleOperationExecuting,
    ).not.toHaveBeenCalled();
  });

  it('bounds cancel by local lease expiry when renewal never settles', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = {
      claimSandboxSessionLifecycleOperation: vi.fn(async (input: {
        sandboxSessionId: string;
        operation: 'checkpoint';
        ownerId: string;
        leaseDurationMs: number;
      }) => ({
        sandboxSessionId: input.sandboxSessionId,
        operation: input.operation,
        operationId: 'logical-checkpoint-1',
        phase: 'reserved' as const,
        ownerId: input.ownerId,
        fenceToken: 3,
        allowedTurnId: null,
        allowedDeliveryOwnerId: null,
        allowedDeliveryFenceToken: null,
        leaseExpiresAt: 100,
        updatedAt: 0,
      })),
      renewSandboxSessionLifecycleOperation: vi.fn(
        () => new Promise<undefined>(() => undefined),
      ),
      markSandboxSessionLifecycleOperationExecuting: vi.fn(async () => true),
      cancelSandboxSessionLifecycleOperation: vi.fn(async () => true),
    };
    const guard = await acquireSandboxSessionLifecycleOperation(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      'checkpoint',
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
        expectedActiveGeneration: {
          restoreFenceToken: 0,
          containerId: null,
        },
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    const cancelled = guard!.cancel();

    localNow = 100;
    await vi.advanceTimersByTimeAsync(75);

    await expect(cancelled).resolves.toBe(false);
    expect(db.cancelSandboxSessionLifecycleOperation).not.toHaveBeenCalled();
  });
});
