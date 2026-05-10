/**
 * Integration tests for the restore retry policy + stranded-RESTORING
 * reconciliation owned by SessionRecoveryCoordinator.
 *
 * Covers ADR 013 budget/backoff and ctx-7fz crash-recovery semantics.
 */
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionRecoveryCoordinator } from '../session-recovery-coordinator.js';
import { SessionStateStore } from '../session-state-store.js';
import { SessionStatusCoordinator } from '../session-status-coordinator.js';
import { InvalidCheckpointError, MAX_RESTORE_ATTEMPTS } from '../restore-retry-policy.js';
import type { SandboxSessionRow } from '../../../database/repository.js';
import type { AgentDefinition } from '../../../types.js';

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
  return {
    id: 'sess-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    containerName: null,
    containerId: null,
    status: 'CHECKPOINTED',
    harnessName: 'langgraph',
    checkpointRef: 'ckpt-1',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    restoreAttempts: 0,
    lastRestoreError: null,
    ...overrides,
  };
}

function createHarness(): TestHarness {
  const stateStore = new SessionStateStore();
  const logger = createLogger();
  const statusUpdates: StatusUpdate[] = [];

  const updateSandboxSessionStatus = vi.fn(async (
    _id: string,
    status: string,
    extra?: Record<string, unknown>,
  ) => {
    statusUpdates.push({ status, extra });
  });

  const statusCoordinator = new SessionStatusCoordinator({
    db: { updateSandboxSessionStatus },
    logger,
    // intentionally omit stateStore so transitions never short-circuit on
    // stale cache state — the test uses fromStatus directly.
  });

  const dbRow = makeRow();

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
        (lastUpdate?.extra?.restoreAttempts as number | null | undefined) ?? dbRow.restoreAttempts,
      lastRestoreError:
        (lastUpdate?.extra?.lastRestoreError as string | null | undefined) ?? dbRow.lastRestoreError,
    };
  });

  const restoreOnce = vi.fn();

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

  // Replace `restoreFromCheckpointOnce` with the test double so we exercise
  // only the retry-loop logic.
  Object.defineProperty(coordinator, 'restoreFromCheckpointOnce', {
    value: restoreOnce,
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

  it('reconciles a session stranded in RESTORING with a valid checkpoint by retrying', async () => {
    const harness = createHarness();
    const stranded = makeRow({ status: 'RESTORING', restoreAttempts: 1 });
    harness.restoreOnce.mockResolvedValueOnce({
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      containerName: 'c',
      containerId: 'c-id',
      status: 'ACTIVE',
      harnessName: 'langgraph',
    });

    const record = await harness.coordinator.reconcileStrandedRestoring(
      'conv-1',
      harness.agentDef,
      'agent-1',
      stranded,
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

  it('reconcileStrandedRestoringOnStartup checkpoints rows with a checkpoint and terminates rows without', async () => {
    const harness = createHarness();

    const withCheckpoint = makeRow({ id: 'sess-with', status: 'RESTORING', restoreAttempts: 0 });
    const withoutCheckpoint = makeRow({ id: 'sess-without', status: 'RESTORING', restoreAttempts: 1 });

    harness.getCheckpointV2.mockImplementation(async (id: string) => {
      if (id === 'sess-with') {
        return {
          id: 'ckpt-1',
          sessionId: 'sess-with',
          agentId: 'agent-1',
          checkpointVersion: 2,
          checkpointData: {},
          harnessState: {},
          workspaceRef: null,
          suspendReason: null,
          createdAt: 0,
        };
      }
      return null;
    });

    const result = await harness.coordinator.reconcileStrandedRestoringOnStartup([
      withCheckpoint,
      withoutCheckpoint,
    ]);

    expect(result).toEqual({ checkpointed: 1, terminated: 1 });

    const checkpointedUpdate = harness.statusUpdates.find((u) => u.status === 'CHECKPOINTED');
    const terminatedUpdate = harness.statusUpdates.find((u) => u.status === 'TERMINATED');
    expect(checkpointedUpdate?.extra).toMatchObject({
      lastRestoreError: expect.stringContaining('orchestrator'),
    });
    expect(terminatedUpdate?.extra).toMatchObject({
      lastRestoreError: expect.stringContaining('no recoverable checkpoint'),
    });
  });

  it('reconcileStrandedRestoring with no checkpoint terminates the session and creates a fresh one', async () => {
    const harness = createHarness();
    harness.getCheckpointV2.mockResolvedValueOnce(null);
    const stranded = makeRow({ status: 'RESTORING', restoreAttempts: 0 });

    const record = await harness.coordinator.reconcileStrandedRestoring(
      'conv-1',
      harness.agentDef,
      'agent-1',
      stranded,
    );

    expect(record.sessionId).toBe('fresh');
    const terminated = harness.statusUpdates.find((u) => u.status === 'TERMINATED');
    expect(terminated?.extra).toMatchObject({
      lastRestoreError: expect.stringContaining('no recoverable checkpoint'),
    });
  });
});
