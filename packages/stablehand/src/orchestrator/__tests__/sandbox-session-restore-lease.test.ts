import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SandboxSessionRow } from '../../database/repository.js';
import { acquireSandboxSessionRestoreLease } from '../sandbox-session-restore-lease.js';

function restoringSession(
  overrides: Partial<SandboxSessionRow> = {},
): SandboxSessionRow {
  return {
    id: 'sandbox-session-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    containerName: null,
    containerId: null,
    status: 'RESTORING',
    harnessName: 'langgraph',
    checkpointRef: null,
    createdAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    restoreAttempts: 1,
    lastRestoreError: null,
    restoreOwnerId: 'replica-a',
    restoreFenceToken: 3,
    restoreLeaseExpiresAt: 100,
    ...overrides,
  };
}

function createDb() {
  return {
    claimSandboxSessionRestore: vi.fn(async () => restoringSession()),
    renewSandboxSessionRestoreLease: vi.fn(
      async () => restoringSession({ restoreLeaseExpiresAt: 125 }),
    ),
    completeSandboxSessionRestore: vi.fn(
      async (
        _sandboxSessionId: string,
        _fence: { ownerId: string; fenceToken: number },
        runtime: { containerName: string; containerId: string },
      ) => restoringSession({
        status: 'ACTIVE',
        containerName: runtime.containerName,
        containerId: runtime.containerId,
        restoreOwnerId: null,
        restoreLeaseExpiresAt: null,
      }),
    ),
    failSandboxSessionRestore: vi.fn(async () => restoringSession({
      status: 'CHECKPOINTED',
      restoreOwnerId: null,
      restoreLeaseExpiresAt: null,
    })),
  };
}

describe('sandbox session restore lease', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not extend the initial lease by a delayed claim response', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = createDb();
    let resolveClaim:
      ((session: SandboxSessionRow) => void)
      | undefined;
    db.claimSandboxSessionRestore.mockImplementation(
      () => new Promise<SandboxSessionRow>((resolve) => {
        resolveClaim = resolve;
      }),
    );

    const acquiring = acquireSandboxSessionRestoreLease(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      3,
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );
    await Promise.resolve();
    localNow = 100;
    resolveClaim!(restoringSession());

    const lease = await acquiring;
    expect(lease).toBeDefined();
    expect(lease!.signal.aborted).toBe(true);
    await expect(lease!.complete({
      containerName: 'sandbox-container-1',
      containerId: 'container-1',
    })).resolves.toBeUndefined();
    expect(db.completeSandboxSessionRestore).not.toHaveBeenCalled();
    await lease!.stop();
  });

  it('expires a renewed lease from renewal request start, not response time', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = createDb();
    let resolveRenewal:
      ((session: SandboxSessionRow) => void)
      | undefined;
    db.renewSandboxSessionRestoreLease.mockImplementation(
      () => new Promise<SandboxSessionRow>((resolve) => {
        resolveRenewal = resolve;
      }),
    );
    const lease = await acquireSandboxSessionRestoreLease(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      3,
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    localNow = 90;
    resolveRenewal!(restoringSession({ restoreLeaseExpiresAt: 125 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(lease!.signal.aborted).toBe(false);

    localNow = 125;
    await vi.advanceTimersByTimeAsync(35);
    expect(lease!.signal.aborted).toBe(true);
    await lease!.stop();
  });

  it('rejects a renewal response that consumed its local lease', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = createDb();
    let resolveRenewal:
      ((session: SandboxSessionRow) => void)
      | undefined;
    db.renewSandboxSessionRestoreLease.mockImplementation(
      () => new Promise<SandboxSessionRow>((resolve) => {
        resolveRenewal = resolve;
      }),
    );
    const lease = await acquireSandboxSessionRestoreLease(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      3,
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    localNow = 125;
    resolveRenewal!(restoringSession({ restoreLeaseExpiresAt: 125 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(lease!.signal.aborted).toBe(true);
    await expect(lease!.fail(
      'CHECKPOINTED',
      'delayed renewal response',
    )).resolves.toBeUndefined();
    expect(db.failSandboxSessionRestore).not.toHaveBeenCalled();
    await lease!.stop();
  });

  it('renews and completes with the exact claimed restore generation', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = createDb();
    const lease = await acquireSandboxSessionRestoreLease(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      3,
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);

    expect(db.renewSandboxSessionRestoreLease).toHaveBeenCalledWith(
      'sandbox-session-1',
      { ownerId: 'replica-a', fenceToken: 3 },
      100,
    );

    const completed = await lease!.complete({
      containerName: 'sandbox-container-1',
      containerId: 'container-1',
    });

    expect(completed?.status).toBe('ACTIVE');
    expect(db.completeSandboxSessionRestore).toHaveBeenCalledWith(
      'sandbox-session-1',
      { ownerId: 'replica-a', fenceToken: 3 },
      {
        containerName: 'sandbox-container-1',
        containerId: 'container-1',
      },
    );
    await lease!.stop();
  });

  it('bounds stop by local lease expiry when renewal never settles', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = createDb();
    db.renewSandboxSessionRestoreLease.mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const lease = await acquireSandboxSessionRestoreLease(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      3,
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);
    expect(db.renewSandboxSessionRestoreLease).toHaveBeenCalledOnce();

    let stopped = false;
    const stop = lease!.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    localNow = 100;
    await vi.advanceTimersByTimeAsync(75);
    await stop;

    expect(lease!.signal.aborted).toBe(true);
    expect(lease!.signal.reason).toEqual(expect.objectContaining({
      message: 'restore lease expired for sandbox session sandbox-session-1',
    }));
  });

  it('does not complete after a renewal loses ownership', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    const db = createDb();
    db.renewSandboxSessionRestoreLease.mockResolvedValue(undefined);
    const lease = await acquireSandboxSessionRestoreLease(
      { db, logger: { warn: vi.fn() } },
      'sandbox-session-1',
      3,
      {
        ownerId: 'replica-a',
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => localNow,
      },
    );

    localNow = 25;
    await vi.advanceTimersByTimeAsync(25);

    await expect(lease!.complete({
      containerName: 'sandbox-container-1',
      containerId: 'container-1',
    })).resolves.toBeUndefined();
    expect(lease!.signal.aborted).toBe(true);
    expect(db.completeSandboxSessionRestore).not.toHaveBeenCalled();
    await lease!.stop();
  });
});
