/**
 * Integration tests for the restore retry policy + expired-restore
 * reconciliation owned by SessionRecoveryCoordinator.
 *
 * Covers ADR 013 budget/backoff and ctx-7fz crash-recovery semantics.
 */
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionRecoveryCoordinator,
  SessionRestoreInProgressError,
} from '../session-recovery-coordinator.js';
import { SessionStateStore } from '../session-state-store.js';
import {
  SessionStatusCoordinator,
  StaleTransitionError,
} from '../session-status-coordinator.js';
import {
  decideRestoreOutcome,
  InvalidCheckpointError,
  MAX_RESTORE_ATTEMPTS,
} from '../restore-retry-policy.js';
import type { SandboxSessionRow } from '../../../database/repository.js';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';

type StatusUpdate = {
  status: string;
  extra?: Record<string, unknown>;
};

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

interface TestHarness {
  coordinator: SessionRecoveryCoordinator;
  statusCoordinator: SessionStatusCoordinator;
  stateStore: SessionStateStore;
  statusUpdates: StatusUpdate[];
  dbRow: SandboxSessionRow;
  restoreOnce: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  getCheckpointV2: ReturnType<typeof vi.fn>;
  getSandboxSession: ReturnType<typeof vi.fn>;
  reconcileExpiredSandboxSessionRestore: ReturnType<typeof vi.fn>;
  agentDef: AgentDefinition;
}

function makeAgentDef(): AgentDefinition {
  return {
    name: 'agent-1',
    harness: 'langgraph',
    systemPrompt: 'sys',
    tools: [],
    harnessConfig: {},
  } as unknown as AgentDefinition;
}

function makeRow(overrides: Partial<SandboxSessionRow> = {}): SandboxSessionRow {
  const status = overrides.status ?? 'CHECKPOINTED';
  return {
    id: 'sess-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    containerName: null,
    containerId: null,
    status,
    harnessName: 'langgraph',
    checkpointRef: null,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    restoreAttempts: 0,
    lastRestoreError: null,
    restoreOwnerId: status === 'RESTORING' ? 'restore-owner' : null,
    restoreFenceToken: status === 'RESTORING' ? 1 : 0,
    restoreLeaseExpiresAt:
      status === 'RESTORING' ? Date.now() + 60_000 : null,
    ...overrides,
  };
}

function createHarness(): TestHarness {
  const stateStore = new SessionStateStore();
  const logger = createLogger();
  const statusUpdates: StatusUpdate[] = [];

  const updateSandboxSessionMetadata = vi.fn(async (
    _id: string,
    status: string,
    extra?: Record<string, unknown>,
  ) => {
    statusUpdates.push({ status, extra });
  });

  const statusCoordinator = new SessionStatusCoordinator({
    db: { updateSandboxSessionMetadata },
    logger,
    // intentionally omit stateStore so transitions never short-circuit on
    // stale cache state — the test uses fromStatus directly.
  });

  const dbRow = makeRow();
  const restoreOnce = vi.fn();

  const getCheckpointV2 = vi.fn().mockResolvedValue({
    id: 'ckpt-1',
    sessionId: dbRow.id,
    agentId: dbRow.agentId,
    checkpointVersion: 2,
    checkpointData: {},
    harnessState: {},
    workspaceRef: null,
    suspendReason: null,
    createdAt: 0,
  });

  const getSandboxSession = vi.fn(async (_id: string) => {
    // Reflect the latest DB-side state by synthesizing a row whose
    // `restoreAttempts` and `status` match the most recent update.
    const lastUpdate = statusUpdates[statusUpdates.length - 1];
    return {
      ...dbRow,
      status: lastUpdate?.status ?? dbRow.status,
      restoreAttempts:
        (lastUpdate?.extra?.restoreAttempts as number | null | undefined)
          ?? dbRow.restoreAttempts,
      lastRestoreError:
        (lastUpdate?.extra?.lastRestoreError as string | null | undefined) ?? dbRow.lastRestoreError,
    };
  });

  const reconcileExpiredSandboxSessionRestore = vi.fn()
    .mockResolvedValue(undefined);

  const containerManager = {
    createContainer: vi.fn(),
    startContainer: vi.fn(),
    stopContainer: vi.fn(),
    removeContainer: vi.fn(),
    getContainer: vi.fn(),
  };

  const sleep = vi.fn(async () => {});

  const coordinator = new SessionRecoveryCoordinator({
    containerManager: containerManager as unknown as Parameters<
      typeof SessionRecoveryCoordinator
    >[0]['containerManager'],
    db: {
      getCheckpointV2,
      getSandboxSession,
      reconcileExpiredSandboxSessionRestore,
    },
    statusCoordinator,
    stateStore,
    buildSandboxSecrets: async () => ({}),
    resolveToolsForAgent: () => [],
    workspaceDiffService: { capture: vi.fn(), restore: vi.fn() } as unknown as Parameters<
      typeof SessionRecoveryCoordinator
    >[0]['workspaceDiffService'],
    logger,
    createFreshSession: vi.fn().mockResolvedValue({
      sessionId: 'fresh',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      containerName: '',
      containerId: '',
      status: 'ACTIVE',
      harnessName: 'langgraph',
    }),
    getExistingConversationWorkspaceDir: vi.fn().mockResolvedValue(undefined),
    sleep,
  });

  // Replace the container work with a double while preserving the production
  // invariant that one fenced attempt durably records its outcome before the
  // retry loop observes the row.
  Object.defineProperty(coordinator, 'restoreFromCheckpointOnce', {
    value: async (...args: Parameters<
      SessionRecoveryCoordinator['restoreFromCheckpointOnce']
    >) => {
      try {
        return await restoreOnce(...args);
      } catch (error) {
        if (
          error instanceof SessionRestoreInProgressError
          || error instanceof StaleTransitionError
        ) {
          throw error;
        }
        const attempt = Math.max(
          statusUpdates.length + 1,
          (args[0].restoreAttempts ?? 0) + 1,
        );
        const outcome = decideRestoreOutcome(error, attempt);
        statusUpdates.push({
          status:
            outcome.toStatus === 'TERMINATED'
              ? 'TERMINATED'
              : 'CHECKPOINTED',
          extra: {
            restoreAttempts: attempt,
            lastRestoreError: outcome.classification.message,
          },
        });
        throw error;
      }
    },
    writable: true,
  });

  return {
    coordinator,
    statusCoordinator,
    stateStore,
    statusUpdates,
    dbRow,
    restoreOnce,
    sleep,
    getCheckpointV2,
    getSandboxSession,
    reconcileExpiredSandboxSessionRestore,
    agentDef: makeAgentDef(),
  };
}

describe('SessionRecoveryCoordinator — restore retry policy (ADR 013)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('succeeds on the third attempt after two transient failures and lands ACTIVE with attempts=0', async () => {
    const harness = createHarness();
    harness.restoreOnce
      .mockRejectedValueOnce(new ConnectError('temp-1', Code.Unavailable))
      .mockRejectedValueOnce(new ConnectError('temp-2', Code.Unavailable))
      .mockResolvedValueOnce({
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        containerName: 'c',
        containerId: 'c-id',
        status: 'ACTIVE',
        harnessName: 'langgraph',
      });

    const record = await harness.coordinator.restoreFromCheckpointWithRetry(
      harness.dbRow,
      harness.agentDef,
    );

    expect(record.status).toBe('ACTIVE');
    expect(harness.restoreOnce).toHaveBeenCalledTimes(3);
    // First two failures park the session in CHECKPOINTED with the attempts
    // counter incremented. The wrapper transitions inner-once also goes through
    // CHECKPOINTED so we expect at least two CHECKPOINTED writes.
    const checkpointed = harness.statusUpdates.filter((u) => u.status === 'CHECKPOINTED');
    expect(checkpointed.length).toBeGreaterThanOrEqual(2);
    expect(checkpointed[0]?.extra).toMatchObject({ restoreAttempts: 1, lastRestoreError: expect.stringContaining('temp-1') });
    expect(checkpointed[1]?.extra).toMatchObject({ restoreAttempts: 2, lastRestoreError: expect.stringContaining('temp-2') });
    // Sleep used for both retry waits with backoff schedule.
    expect(harness.sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 15_000]);
  });

  it('lands in CHECKPOINTED with last_restore_error after MAX retryable failures', async () => {
    const harness = createHarness();
    harness.restoreOnce.mockRejectedValue(new ConnectError('flaky', Code.Unavailable));

    await expect(
      harness.coordinator.restoreFromCheckpointWithRetry(harness.dbRow, harness.agentDef),
    ).rejects.toThrow('flaky');

    expect(harness.restoreOnce).toHaveBeenCalledTimes(MAX_RESTORE_ATTEMPTS);

    // The final transition must be CHECKPOINTED with attempts=MAX and
    // lastRestoreError populated.
    const final = harness.statusUpdates[harness.statusUpdates.length - 1];
    expect(final.status).toBe('CHECKPOINTED');
    expect(final.extra).toMatchObject({
      restoreAttempts: MAX_RESTORE_ATTEMPTS,
      lastRestoreError: expect.stringContaining('flaky'),
    });

    // No TERMINATED transition occurred for retryable budget exhaustion.
    expect(harness.statusUpdates.find((u) => u.status === 'TERMINATED')).toBeUndefined();

    // Backoff sleeps were called for the two intermediate retries only —
    // after the third (final) failure we do not sleep.
    expect(harness.sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 15_000]);
  });

  it('does not consume the persisted restore budget when admission fails before a claim', async () => {
    const harness = createHarness();
    const admittedRestore = harness.coordinator.restoreFromCheckpointOnce.bind(
      harness.coordinator,
    );
    let admissionFailed = false;
    const restoreAttempt = vi.fn(async (
      ...args: Parameters<
        SessionRecoveryCoordinator['restoreFromCheckpointOnce']
      >
    ) => {
      if (!admissionFailed) {
        admissionFailed = true;
        throw new Error('database unavailable before restore admission');
      }
      return admittedRestore(...args);
    });
    Object.defineProperty(harness.coordinator, 'restoreFromCheckpointOnce', {
      value: restoreAttempt,
      writable: true,
    });

    await expect(
      harness.coordinator.restoreFromCheckpointWithRetry(
        harness.dbRow,
        harness.agentDef,
      ),
    ).rejects.toThrow('database unavailable before restore admission');

    expect(restoreAttempt).toHaveBeenCalledOnce();
    expect(harness.statusUpdates).toEqual([]);
    expect(harness.sleep).not.toHaveBeenCalled();

    harness.restoreOnce.mockRejectedValue(
      new ConnectError('admitted failure', Code.Unavailable),
    );
    await expect(
      harness.coordinator.restoreFromCheckpointWithRetry(
        harness.dbRow,
        harness.agentDef,
      ),
    ).rejects.toThrow('admitted failure');

    expect(harness.restoreOnce).toHaveBeenCalledTimes(MAX_RESTORE_ATTEMPTS);
    expect(
      harness.statusUpdates.at(-1)?.extra,
    ).toMatchObject({ restoreAttempts: MAX_RESTORE_ATTEMPTS });
  });

  it('non-retryable failure bypasses retry and goes to TERMINATED on first try', async () => {
    const harness = createHarness();
    harness.restoreOnce.mockRejectedValueOnce(new InvalidCheckpointError('checkpoint corrupt'));

    await expect(
      harness.coordinator.restoreFromCheckpointWithRetry(harness.dbRow, harness.agentDef),
    ).rejects.toThrow('checkpoint corrupt');

    expect(harness.restoreOnce).toHaveBeenCalledTimes(1);

    const terminated = harness.statusUpdates.find((u) => u.status === 'TERMINATED');
    expect(terminated).toBeDefined();
    expect(terminated?.extra).toMatchObject({
      restoreAttempts: 1,
      lastRestoreError: expect.stringContaining('checkpoint corrupt'),
    });
    expect(harness.sleep).not.toHaveBeenCalled();
  });

  it('explicitly reconciles an expired restore generation before retrying', async () => {
    const harness = createHarness();
    const expiredRestore = makeRow({
      status: 'RESTORING',
      restoreAttempts: 1,
    });
    const reconciliationError = 'orchestrator restarted while restoring';
    harness.reconcileExpiredSandboxSessionRestore.mockImplementationOnce(
      async () => {
        harness.statusUpdates.push({
          status: 'CHECKPOINTED',
          extra: {
            restoreAttempts: 1,
            lastRestoreError: reconciliationError,
          },
        });
        return {
          session: makeRow({
            status: 'CHECKPOINTED',
            restoreAttempts: 1,
            lastRestoreError: reconciliationError,
            restoreFenceToken: expiredRestore.restoreFenceToken + 1,
          }),
          outcome: 'CHECKPOINTED',
        };
      },
    );
    harness.restoreOnce.mockResolvedValueOnce({
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      containerName: 'c',
      containerId: 'c-id',
      status: 'ACTIVE',
      harnessName: 'langgraph',
    });

    const outcome = await harness.coordinator.reconcileExpiredSandboxSessionRestore(
      expiredRestore,
    );
    expect(outcome).toBe('CHECKPOINTED');
    const record = await harness.coordinator.restoreFromCheckpointWithRetry(
      { ...expiredRestore, status: 'CHECKPOINTED' },
      harness.agentDef,
    );

    expect(record.status).toBe('ACTIVE');
    // The reconciler first demotes RESTORING -> CHECKPOINTED so the retry
    // budget can be honoured.
    const firstUpdate = harness.statusUpdates[0];
    expect(firstUpdate.status).toBe('CHECKPOINTED');
    expect(firstUpdate.extra).toMatchObject({
      lastRestoreError: expect.stringContaining('orchestrator'),
    });
  });

  it('reconcileExpiredSandboxSessionRestore with no checkpoint terminates the session', async () => {
    const harness = createHarness();
    harness.getCheckpointV2.mockResolvedValueOnce(null);
    const expiredRestore = makeRow({
      status: 'RESTORING',
      restoreAttempts: 0,
    });
    const reconciliationError =
      'orchestrator restart: no recoverable checkpoint';
    harness.reconcileExpiredSandboxSessionRestore.mockImplementationOnce(
      async () => {
        harness.statusUpdates.push({
          status: 'TERMINATED',
          extra: {
            restoreAttempts: 0,
            lastRestoreError: reconciliationError,
          },
        });
        return {
          session: makeRow({
            status: 'TERMINATED',
            lastRestoreError: reconciliationError,
            restoreFenceToken: expiredRestore.restoreFenceToken + 1,
          }),
          outcome: 'TERMINATED',
        };
      },
    );

    const outcome = await harness.coordinator.reconcileExpiredSandboxSessionRestore(
      expiredRestore,
    );

    expect(outcome).toBe('TERMINATED');
    const terminated = harness.statusUpdates.find((u) => u.status === 'TERMINATED');
    expect(terminated?.extra).toMatchObject({
      lastRestoreError: expect.stringContaining('no recoverable checkpoint'),
    });
  });

  it('joins another replica restoring the same session without demoting it', async () => {
    const harness = createHarness();
    const restoring = makeRow({ status: 'RESTORING', restoreAttempts: 1 });
    const active = makeRow({
      status: 'ACTIVE',
      containerId: 'container-live',
      containerName: 'container-live',
      restoreAttempts: 0,
    });
    harness.getSandboxSession
      .mockResolvedValueOnce(restoring)
      .mockResolvedValueOnce(active);
    const reconnected = {
      sessionId: active.id,
      conversationId: active.conversationId,
      agentId: active.agentId,
      containerName: 'container-live',
      containerId: 'container-live',
      status: 'ACTIVE' as const,
      harnessName: active.harnessName,
    };
    vi.spyOn(harness.coordinator, 'reconnectToContainer')
      .mockResolvedValue(reconnected);

    const record = await harness.coordinator.recoverOrReconnect(
      restoring.conversationId,
      harness.agentDef,
      restoring.agentId,
      restoring,
    );

    expect(record).toEqual(reconnected);
    expect(harness.statusUpdates).toEqual([]);
    expect(harness.restoreOnce).not.toHaveBeenCalled();
  });

  it('joins the same-row restore winner after losing CHECKPOINTED admission', async () => {
    const harness = createHarness();
    const restoring = makeRow({ status: 'RESTORING', restoreAttempts: 1 });
    const active = makeRow({
      status: 'ACTIVE',
      containerId: 'container-live',
      containerName: 'container-live',
      restoreAttempts: 0,
    });
    harness.restoreOnce.mockRejectedValueOnce(
      new StaleTransitionError('sess-1', 'CHECKPOINTED', 'RESTORING'),
    );
    harness.getSandboxSession
      .mockResolvedValueOnce(restoring)
      .mockResolvedValueOnce(active);
    const reconnected = {
      sessionId: active.id,
      conversationId: active.conversationId,
      agentId: active.agentId,
      containerName: 'container-live',
      containerId: 'container-live',
      status: 'ACTIVE' as const,
      harnessName: active.harnessName,
    };
    vi.spyOn(harness.coordinator, 'reconnectToContainer')
      .mockResolvedValue(reconnected);

    const record = await harness.coordinator.restoreFromCheckpointWithRetry(
      makeRow({ status: 'CHECKPOINTED' }),
      harness.agentDef,
    );

    expect(record).toEqual(reconnected);
    expect(harness.statusUpdates).toEqual([]);
    expect(harness.restoreOnce).toHaveBeenCalledOnce();
  });

  it('joins a peer that acquires restore admission during retry backoff', async () => {
    const harness = createHarness();
    const restoring = makeRow({ status: 'RESTORING', restoreAttempts: 1 });
    const active = makeRow({
      status: 'ACTIVE',
      containerId: 'container-peer',
      containerName: 'container-peer',
      restoreAttempts: 0,
    });
    harness.restoreOnce.mockRejectedValueOnce(
      new ConnectError('transient restore failure', Code.Unavailable),
    );
    harness.getSandboxSession
      .mockResolvedValueOnce(restoring)
      .mockResolvedValueOnce(active);
    const reconnected = {
      sessionId: active.id,
      conversationId: active.conversationId,
      agentId: active.agentId,
      containerName: 'container-peer',
      containerId: 'container-peer',
      status: 'ACTIVE' as const,
      harnessName: active.harnessName,
    };
    vi.spyOn(harness.coordinator, 'reconnectToContainer')
      .mockResolvedValue(reconnected);

    const record = await harness.coordinator.restoreFromCheckpointWithRetry(
      makeRow({ status: 'CHECKPOINTED' }),
      harness.agentDef,
    );

    expect(record).toEqual(reconnected);
    expect(harness.restoreOnce).toHaveBeenCalledOnce();
    expect(harness.statusUpdates).toEqual([
      expect.objectContaining({
        status: 'CHECKPOINTED',
        extra: expect.objectContaining({ restoreAttempts: 1 }),
      }),
    ]);
  });

  it('honours restore attempts consumed by a peer during backoff', async () => {
    const harness = createHarness();
    harness.restoreOnce
      .mockRejectedValueOnce(new ConnectError('local attempt one', Code.Unavailable))
      .mockRejectedValueOnce(new ConnectError('local global attempt three', Code.Unavailable));
    harness.getSandboxSession.mockResolvedValue(
      makeRow({
        status: 'CHECKPOINTED',
        restoreAttempts: 2,
        lastRestoreError: 'peer consumed attempt two',
      }),
    );

    await expect(harness.coordinator.restoreFromCheckpointWithRetry(
      makeRow({ status: 'CHECKPOINTED', restoreAttempts: 0 }),
      harness.agentDef,
    )).rejects.toThrow('local global attempt three');

    expect(harness.restoreOnce).toHaveBeenCalledTimes(2);
    expect(harness.statusUpdates.at(-1)).toEqual(expect.objectContaining({
      status: 'CHECKPOINTED',
      extra: expect.objectContaining({
        restoreAttempts: 3,
        lastRestoreError: expect.stringContaining('local global attempt three'),
      }),
    }));
  });

  it('leaves a long-running cross-replica restore untouched when join wait expires', async () => {
    const harness = createHarness();
    const restoring = makeRow({ status: 'RESTORING', restoreAttempts: 1 });
    harness.getSandboxSession.mockResolvedValue(restoring);

    await expect(harness.coordinator.recoverOrReconnect(
      restoring.conversationId,
      harness.agentDef,
      restoring.agentId,
      restoring,
    )).rejects.toBeInstanceOf(SessionRestoreInProgressError);

    expect(harness.statusUpdates).toEqual([]);
    expect(harness.restoreOnce).not.toHaveBeenCalled();
  });
});
