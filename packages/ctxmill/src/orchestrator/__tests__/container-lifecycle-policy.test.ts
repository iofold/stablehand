import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import { SessionStateStore } from '../session-manager/session-state-store.js';
import { SessionStatusCoordinator } from '../session-manager/session-status-coordinator.js';

const grpcSessionClientMocks = vi.hoisted(() => ({
  waitForContainerReady: vi.fn(),
}));

vi.mock('../session-manager/grpc-session-client.js', () => ({
  waitForContainerReady: grpcSessionClientMocks.waitForContainerReady,
}));

const mockContainerManager = {
  isContainerAlive: vi.fn(),
  listManagedContainers: vi.fn(),
  listManagedContainersWithLabels: vi.fn(),
  stopContainer: vi.fn(),
  removeContainer: vi.fn(),
  releaseContainerSlot: vi.fn(),
  createContainer: vi.fn(),
  startContainer: vi.fn(),
  getRuntimeInstanceToken: vi.fn(),
} as any;

const mockDb = {
  getActiveSandboxSessions: vi.fn(),
  getRestoringSandboxSessions: vi.fn(),
  getExpiredSandboxSessionRestores: vi.fn(),
  hasLiveTurnDeliveryForSandboxSession: vi.fn(),
  hasQueuedTurnsForSandboxSession: vi.fn(),
  recordSandboxSessionCheckpointFailure: vi.fn().mockResolvedValue(1),
  clearSandboxSessionCheckpointFailures: vi.fn().mockResolvedValue(undefined),
  hasUnfinishedSandboxSessionLifecycleOperation: vi.fn(),
  getRecoverableSandboxSessionLifecycleOperations: vi.fn(),
  getSandboxSession: vi.fn(),
  claimSandboxSessionLifecycleOperation: vi.fn(),
  renewSandboxSessionLifecycleOperation: vi.fn(),
  markSandboxSessionLifecycleOperationExecuting: vi.fn(),
  cancelSandboxSessionLifecycleOperation: vi.fn(),
  completeSandboxSessionLifecycleOperation: vi.fn(),
  updateSandboxSessionMetadata: vi.fn(),
  getCheckpointV2: vi.fn(),
  getCheckpointV2ForLifecycleOperation: vi.fn(),
  deleteSandboxSession: vi.fn(),
} as any;

const mockOnSessionReconnected = vi.fn();
const mockReconnectionRevoke = vi.fn();
const mockOnSessionEvicted = vi.fn().mockResolvedValue(undefined);
const mockReconcileExpiredSandboxSessionRestore = vi.fn();

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const TEST_CONFIG = {
  reconciliationIntervalMs: 60_000,
  idleTimeoutMs: 2_000,
};

function createSession(overrides: Record<string, unknown> = {}) {
  const status = overrides.status ?? 'ACTIVE';
  return {
    id: 'session-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    containerId: 'container-1',
    containerName: 'container-1',
    status,
    harnessName: 'test-harness',
    checkpointRef: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    restoreAttempts: 0,
    lastRestoreError: null,
    restoreOwnerId: status === 'RESTORING' ? 'restore-owner' : null,
    restoreFenceToken: status === 'RESTORING' ? 1 : 0,
    restoreLeaseExpiresAt:
      status === 'RESTORING' ? Date.now() + 60_000 : null,
    ...overrides,
  };
}

function createContainer(overrides: Record<string, unknown> = {}) {
  return {
    containerId: 'container-1',
    containerName: 'container-1',
    status: 'running',
    labels: {},
    ...overrides,
  };
}

function createPolicy() {
  const stateStore = new SessionStateStore();
  const statusCoordinator = new SessionStatusCoordinator({
    db: mockDb,
    logger: mockLogger,
    stateStore,
  });

  return new ContainerLifecyclePolicy({
    containerManager: mockContainerManager,
    db: mockDb,
    logger: mockLogger,
    config: TEST_CONFIG,
    reconciliationCallbacks: {
      onSessionReconnected: mockOnSessionReconnected,
      onSessionEvicted: mockOnSessionEvicted,
      reconcileExpiredSandboxSessionRestore:
        mockReconcileExpiredSandboxSessionRestore,
    },
    statusCoordinator,
  });
}

function getRunReconciliation(policy: ContainerLifecyclePolicy) {
  return Reflect.get(policy, 'runReconciliation').bind(policy) as () => Promise<void>;
}

function getShouldKillContainer(policy: ContainerLifecyclePolicy) {
  return Reflect.get(policy, 'shouldKillContainer').bind(policy) as (
    containerId: string,
    sessionId?: string,
  ) => Promise<'kill' | 'kill-after-checkpoint' | 'skip'>;
}

function getReconcileOnStartup(policy: ContainerLifecyclePolicy) {
  return Reflect.get(policy, 'reconcileOnStartup').bind(policy) as () => Promise<void>;
}

function getReconcileExpiredLifecycleOperations(
  policy: ContainerLifecyclePolicy,
) {
  return Reflect.get(
    policy,
    'reconcileExpiredLifecycleOperations',
  ).bind(policy) as () => Promise<void>;
}

function getExecuteIdleCheckpoint(policy: ContainerLifecyclePolicy) {
  return Reflect.get(policy, 'executeIdleCheckpoint').bind(policy) as (sessionId: string) => Promise<void>;
}

describe('ContainerLifecyclePolicy', () => {
  let policy: ContainerLifecyclePolicy;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();

    mockContainerManager.isContainerAlive.mockResolvedValue(true);
    mockContainerManager.listManagedContainers.mockResolvedValue([]);
    mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([]);
    mockContainerManager.stopContainer.mockResolvedValue(undefined);
    mockContainerManager.removeContainer.mockResolvedValue(undefined);
    mockContainerManager.releaseContainerSlot.mockReturnValue(false);
    mockContainerManager.getRuntimeInstanceToken.mockResolvedValue(
      'runtime-instance-token-1',
    );
    grpcSessionClientMocks.waitForContainerReady.mockResolvedValue({
      grpcClient: { killSession: vi.fn() },
      transport: {},
    });

    mockDb.getActiveSandboxSessions.mockResolvedValue([]);
    mockDb.getRestoringSandboxSessions.mockResolvedValue([]);
    mockDb.getExpiredSandboxSessionRestores.mockResolvedValue([]);
    mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValue(false);
    mockDb.hasQueuedTurnsForSandboxSession.mockResolvedValue(false);
    mockDb.recordSandboxSessionCheckpointFailure.mockResolvedValue(1);
    mockDb.clearSandboxSessionCheckpointFailures.mockResolvedValue(undefined);
    mockDb.hasUnfinishedSandboxSessionLifecycleOperation.mockResolvedValue(false);
    mockDb.getRecoverableSandboxSessionLifecycleOperations.mockResolvedValue([]);
    mockDb.getSandboxSession.mockResolvedValue(null);
    mockDb.claimSandboxSessionLifecycleOperation.mockImplementation(async (input) => ({
      sandboxSessionId: input.sandboxSessionId,
      operation: input.operation,
      operationId: 'lifecycle-operation-1',
      phase: 'reserved',
      ownerId: input.ownerId,
      fenceToken: 1,
      allowedTurnId: null,
      allowedDeliveryOwnerId: null,
      allowedDeliveryFenceToken: null,
      leaseExpiresAt: Date.now() + input.leaseDurationMs,
      updatedAt: Date.now(),
    }));
    mockDb.renewSandboxSessionLifecycleOperation.mockResolvedValue({
      sandboxSessionId: 'session-1',
      operation: 'reset',
      operationId: 'lifecycle-operation-1',
      phase: 'executing',
      ownerId: 'owner',
      fenceToken: 1,
      allowedTurnId: null,
      allowedDeliveryOwnerId: null,
      allowedDeliveryFenceToken: null,
      leaseExpiresAt: Date.now() + 60_000,
      updatedAt: Date.now(),
    });
    mockDb.markSandboxSessionLifecycleOperationExecuting.mockResolvedValue(true);
    mockDb.cancelSandboxSessionLifecycleOperation.mockResolvedValue(true);
    mockDb.completeSandboxSessionLifecycleOperation.mockResolvedValue(true);
    mockDb.updateSandboxSessionMetadata.mockResolvedValue(undefined);
    mockDb.getCheckpointV2.mockResolvedValue(null);
    mockDb.getCheckpointV2ForLifecycleOperation.mockResolvedValue(null);
    mockDb.deleteSandboxSession.mockResolvedValue(undefined);

    mockOnSessionReconnected.mockReset();
    mockReconnectionRevoke.mockReset();
    mockReconnectionRevoke.mockResolvedValue(undefined);
    mockOnSessionReconnected.mockReturnValue({
      revoke: mockReconnectionRevoke,
    });
    mockOnSessionEvicted.mockReset();
    mockReconcileExpiredSandboxSessionRestore.mockReset();

    policy = createPolicy();
  });

  afterEach(() => {
    policy.stop();
    policy.cleanupAll();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('Idle timeout lifecycle', () => {
    it('scheduleIdleTimeout sets idle timer', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs - 1);

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
      expect(policy.getState('session-1')).toBe('none');
    });

    it('after idleTimeoutMs calls onCheckpoint directly', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).toHaveBeenCalledWith('session-1');
      expect(policy.getState('session-1')).toBe('none');
    });

    it('defers idle checkpoint while another replica owns a live turn delivery, then resumes after expiry', async () => {
      const now = Date.UTC(2026, 6, 19, 12, 0, 0);
      vi.setSystemTime(now);
      mockDb.hasLiveTurnDeliveryForSandboxSession
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
        onContainerGone: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(mockDb.hasLiveTurnDeliveryForSandboxSession).toHaveBeenNthCalledWith(
        1,
        'session-1',
      );
      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
      expect(callbacks.onContainerGone).not.toHaveBeenCalled();
      expect(mockDb.updateSandboxSessionMetadata).not.toHaveBeenCalled();
      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
      expect(policy.getState('session-1')).toBe('none');

      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(mockDb.hasLiveTurnDeliveryForSandboxSession).toHaveBeenNthCalledWith(
        2,
        'session-1',
      );
      expect(callbacks.onCheckpoint).toHaveBeenCalledOnce();
      expect(callbacks.onCheckpoint).toHaveBeenCalledWith('session-1');
    });

    it('allows idle checkpoint immediately after the bound turn becomes terminal', async () => {
      const now = Date.UTC(2026, 6, 19, 12, 30, 0);
      vi.setSystemTime(now);
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };
      mockDb.hasLiveTurnDeliveryForSandboxSession
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(mockDb.hasLiveTurnDeliveryForSandboxSession).toHaveBeenCalledTimes(2);
      expect(callbacks.onCheckpoint).toHaveBeenCalledOnce();
    });

    it('fails closed and re-arms idle monitoring when delivery verification fails', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };
      mockDb.hasLiveTurnDeliveryForSandboxSession
        .mockRejectedValueOnce(new Error('temporary database failure'))
        .mockResolvedValueOnce(false);

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
      expect(policy.getState('session-1')).toBe('none');

      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).toHaveBeenCalledOnce();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to verify turn delivery before idle checkpoint'),
        expect.any(Error),
      );
    });

    it('uses updated idleTimeoutMs for newly scheduled idle checkpoints', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.updateConfig({ idleTimeoutMs: 5_000 });

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callbacks.onCheckpoint).toHaveBeenCalledWith('session-1');
    });

    it('cancelIdleTimeout clears idle timer', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await policy.cancelIdleTimeout('session-1');
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
    });

    it('re-arms existing idle timers when idleTimeoutMs changes', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();

      policy.updateConfig({ idleTimeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(callbacks.onCheckpoint).toHaveBeenCalledWith('session-1');
    });

    it('idle checkpoint is skipped when checkpoint promotion is already active', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;
      entries.set('session-1', {
        containerId: 'container-1',
        state: 'promoting',
        idleCallbacks: callbacks,
      });

      const executeIdleCheckpoint = Reflect.get(policy, 'executeIdleCheckpoint').bind(policy) as (
        sessionId: string,
      ) => Promise<void>;

      await executeIdleCheckpoint('session-1');

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
      expect(policy.getState('session-1')).toBe('promoting');
    });

    it('re-arms idle monitoring after a retryable checkpoint failure', async () => {
      const callbacks = {
        onCheckpoint: vi.fn()
          .mockRejectedValueOnce(new Error('temporary checkpoint failure'))
          .mockRejectedValueOnce(new Error('temporary checkpoint failure'))
          .mockRejectedValueOnce(new Error('temporary checkpoint failure'))
          .mockResolvedValue(undefined),
      };
      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;
      entries.set('session-1', {
        containerId: 'container-1',
        state: 'none',
        idleCallbacks: callbacks,
      });
      const executeIdleCheckpoint = getExecuteIdleCheckpoint(policy);

      const firstAttempt = executeIdleCheckpoint('session-1');
      await vi.advanceTimersByTimeAsync(3_000);
      await firstAttempt;

      expect(callbacks.onCheckpoint).toHaveBeenCalledTimes(3);
      expect(policy.getState('session-1')).toBe('none');

      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).toHaveBeenCalledTimes(4);
    });

    it('does not re-arm idle monitoring for terminal container-gone failures', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockRejectedValue({ statusCode: 404, message: 'not found' }),
        onContainerGone: vi.fn().mockResolvedValue(undefined),
      };
      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;
      entries.set('session-1', {
        containerId: 'container-1',
        state: 'none',
        idleCallbacks: callbacks,
      });
      const executeIdleCheckpoint = getExecuteIdleCheckpoint(policy);

      await executeIdleCheckpoint('session-1');
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).toHaveBeenCalledTimes(1);
      expect(callbacks.onContainerGone).toHaveBeenCalledWith('session-1');
      expect(entries.has('session-1')).toBe(false);
    });

    it('forces cleanup after repeated checkpoint-size failures instead of going quiet (ctx-vsf8)', async () => {
      const sizeError = Object.assign(
        new Error('Workspace diff too large: 200 MiB > 100 MiB'),
        { code: 'workspace_diff_too_large' },
      );
      const callbacks = {
        onCheckpoint: vi.fn().mockRejectedValue(sizeError),
        onForceTerminate: vi.fn().mockResolvedValue(undefined),
      };
      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;
      entries.set('session-1', {
        containerId: 'container-1',
        state: 'none',
        idleCallbacks: callbacks,
        idleFailureCount: 3,
      });
      const executeIdleCheckpoint = getExecuteIdleCheckpoint(policy);

      const attempt = executeIdleCheckpoint('session-1');
      await vi.advanceTimersByTimeAsync(3_000);
      await attempt;

      expect(callbacks.onForceTerminate).toHaveBeenCalledWith('session-1');
      expect(entries.has('session-1')).toBe(false);
      expect(mockDb.recordSandboxSessionCheckpointFailure).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('too large'),
        expect.any(Number),
      );
    });

    it('only disables monitoring for repeated transient failures, never force-terminates', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockRejectedValue(new Error('temporary checkpoint failure')),
        onForceTerminate: vi.fn().mockResolvedValue(undefined),
      };
      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;
      entries.set('session-1', {
        containerId: 'container-1',
        state: 'none',
        idleCallbacks: callbacks,
        idleFailureCount: 3,
      });
      const executeIdleCheckpoint = getExecuteIdleCheckpoint(policy);

      const attempt = executeIdleCheckpoint('session-1');
      await vi.advanceTimersByTimeAsync(3_000);
      await attempt;

      expect(callbacks.onForceTerminate).not.toHaveBeenCalled();
      expect(entries.has('session-1')).toBe(false);
      expect(mockDb.recordSandboxSessionCheckpointFailure).toHaveBeenCalled();
    });

    it('cancelIdleTimeout after a retryable checkpoint failure prevents the re-armed retry', async () => {
      const callbacks = {
        onCheckpoint: vi.fn()
          .mockRejectedValueOnce(new Error('temporary checkpoint failure'))
          .mockRejectedValueOnce(new Error('temporary checkpoint failure'))
          .mockRejectedValueOnce(new Error('temporary checkpoint failure'))
          .mockResolvedValue(undefined),
      };
      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;
      entries.set('session-1', {
        containerId: 'container-1',
        state: 'none',
        idleCallbacks: callbacks,
      });
      const executeIdleCheckpoint = getExecuteIdleCheckpoint(policy);

      const firstAttempt = executeIdleCheckpoint('session-1');
      await vi.advanceTimersByTimeAsync(3_000);
      await firstAttempt;
      await policy.cancelIdleTimeout('session-1');
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).toHaveBeenCalledTimes(3);
    });
  });

  describe('Sandbox readback reconciliation', () => {
    it('does not return ACTIVE readback rows whose containers are gone and have no checkpoint', async () => {
      const session = createSession();
      mockDb.getActiveSandboxSessions.mockResolvedValueOnce([session]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValueOnce([]);
      mockDb.getCheckpointV2.mockResolvedValueOnce(null);

      const rows = await policy.getActiveSandboxSessionsForReadback();

      expect(rows).toEqual([]);
      expect(
        mockDb.claimSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: session.id,
        expectedActiveGeneration: {
          restoreFenceToken: session.restoreFenceToken,
          containerId: session.containerId,
        },
      }));
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: session.id,
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
        extra: expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
      }));
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith(session.containerId, true);
      expect(mockOnSessionEvicted).toHaveBeenCalledWith(session.id, session.conversationId);
    });

    it('promotes missing ACTIVE readback rows with checkpoints to CHECKPOINTED', async () => {
      const session = createSession();
      mockDb.getActiveSandboxSessions.mockResolvedValueOnce([session]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValueOnce([]);
      mockDb.getCheckpointV2.mockResolvedValueOnce({ id: 'checkpoint-1' });

      const rows = await policy.getActiveSandboxSessionsForReadback();

      expect(rows).toEqual([]);
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: session.id,
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
        extra: expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
      }));
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith(session.containerId, true);
      expect(mockOnSessionEvicted).toHaveBeenCalledWith(session.id, session.conversationId);
    });

    it('keeps deferred missing rows active for in-flight turn readback', async () => {
      const session = createSession();
      mockDb.getActiveSandboxSessions.mockResolvedValueOnce([session]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValueOnce([]);

      const rows = await policy.getActiveSandboxSessionsForReadback({
        shouldDefer: (candidate) => candidate.id === session.id,
      });

      expect(rows).toEqual([session]);
      expect(mockDb.updateSandboxSessionMetadata).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
      expect(mockOnSessionEvicted).not.toHaveBeenCalled();
    });

    it('keeps a missing ACTIVE row while another replica owns its live delivery', async () => {
      const session = createSession();
      mockDb.getActiveSandboxSessions.mockResolvedValueOnce([session]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValueOnce([]);
      mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValueOnce(true);

      const rows = await policy.getActiveSandboxSessionsForReadback();

      expect(rows).toEqual([session]);
      expect(mockDb.updateSandboxSessionMetadata).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
      expect(mockOnSessionEvicted).not.toHaveBeenCalled();
    });
  });

  describe('shouldKillContainer gate', () => {
    it('no session returns kill', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);

      await expect(shouldKillContainer('container-1')).resolves.toBe('kill');
    });

    it('session with pending idle checkpoint promotion returns skip', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);
      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;

      entries.set('session-1', {
        containerId: 'container-1',
        state: 'promoting',
      });

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('skip');
    });

    it('dead container with a live delivery owned by another replica returns skip', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValue(true);

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('skip');

      expect(mockDb.getCheckpointV2).not.toHaveBeenCalled();
      expect(mockDb.updateSandboxSessionMetadata).not.toHaveBeenCalled();
      expect(mockOnSessionEvicted).not.toHaveBeenCalled();
    });

    it('container alive returns skip', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);

      const conversationIds = Reflect.get(policy, 'sessionConversationIds') as Map<string, string>;
      conversationIds.set('session-1', 'conversation-1');

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('skip');
      expect(mockContainerManager.isContainerAlive).toHaveBeenCalledWith('container-1');
    });

    it('does not demote a restored successor after observing its predecessor dead', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockDb.getSandboxSession.mockResolvedValue(createSession({
        containerId: 'successor-container',
        containerName: 'ctxmill-sandbox-successor',
        restoreFenceToken: 4,
      }));

      await expect(
        shouldKillContainer('container-1', 'session-1'),
      ).resolves.toBe('skip');

      expect(
        mockDb.claimSandboxSessionLifecycleOperation,
      ).not.toHaveBeenCalled();
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).not.toHaveBeenCalled();
    });

    it('container dead with checkpoint marks CHECKPOINTED, evicts session, and returns kill-after-checkpoint', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);

      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockDb.getSandboxSession.mockResolvedValue(createSession());

      const conversationIds = Reflect.get(policy, 'sessionConversationIds') as Map<string, string>;
      conversationIds.set('session-1', 'conversation-1');

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('kill-after-checkpoint');
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: 'session-1',
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
        extra: expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
      }));
      expect(mockOnSessionEvicted).toHaveBeenCalledWith('session-1', 'conversation-1');
    });

    it('container dead without checkpoint marks TERMINATED, evicts session, and returns kill', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);

      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockDb.getSandboxSession.mockResolvedValue(createSession());

      const conversationIds = Reflect.get(policy, 'sessionConversationIds') as Map<string, string>;
      conversationIds.set('session-1', 'conversation-1');

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('kill');
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: 'session-1',
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
        extra: expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
      }));
      expect(mockOnSessionEvicted).toHaveBeenCalledWith('session-1', 'conversation-1');
    });
  });

  describe('reconciliation', () => {
    it('does not promote an old checkpoint for a newer expired checkpoint operation', async () => {
      const session = createSession();
      const expiredOperation = {
        sandboxSessionId: session.id,
        operation: 'checkpoint',
        operationId: 'logical-checkpoint-new',
        phase: 'executing',
        ownerId: 'dead-owner',
        fenceToken: 1,
        allowedTurnId: null,
        allowedDeliveryOwnerId: null,
        allowedDeliveryFenceToken: null,
        leaseExpiresAt: Date.now() - 1,
        updatedAt: Date.now() - 1,
      };
      mockDb.getRecoverableSandboxSessionLifecycleOperations.mockResolvedValue([
        expiredOperation,
      ]);
      mockDb.claimSandboxSessionLifecycleOperation.mockImplementation(
        async (input) => ({
          ...expiredOperation,
          ownerId: input.ownerId,
          fenceToken: 2,
          leaseExpiresAt: Date.now() + input.leaseDurationMs,
          updatedAt: Date.now(),
        }),
      );
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockDb.getCheckpointV2.mockResolvedValue({
        id: 'checkpoint-from-old-logical-operation',
      });
      mockDb.getCheckpointV2ForLifecycleOperation.mockResolvedValue(null);

      await getReconcileExpiredLifecycleOperations(policy)();

      expect(mockDb.getCheckpointV2).not.toHaveBeenCalled();
      expect(
        mockDb.getCheckpointV2ForLifecycleOperation,
      ).toHaveBeenCalledWith(session.id, expiredOperation.operationId);
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: session.id,
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
      }));
    });

    it('accepts a checkpoint written by the prior owner of the same logical operation', async () => {
      const session = createSession();
      const expiredOperation = {
        sandboxSessionId: session.id,
        operation: 'checkpoint',
        operationId: 'logical-checkpoint-shared',
        phase: 'executing',
        ownerId: 'dead-owner',
        fenceToken: 1,
        allowedTurnId: null,
        allowedDeliveryOwnerId: null,
        allowedDeliveryFenceToken: null,
        leaseExpiresAt: Date.now() - 1,
        updatedAt: Date.now() - 1,
      };
      mockDb.getRecoverableSandboxSessionLifecycleOperations.mockResolvedValue([
        expiredOperation,
      ]);
      mockDb.claimSandboxSessionLifecycleOperation.mockImplementation(
        async (input) => ({
          ...expiredOperation,
          ownerId: input.ownerId,
          fenceToken: 2,
          leaseExpiresAt: Date.now() + input.leaseDurationMs,
          updatedAt: Date.now(),
        }),
      );
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockDb.getCheckpointV2ForLifecycleOperation.mockResolvedValue({
        id: 'checkpoint-from-prior-owner',
        lifecycleOperationId: expiredOperation.operationId,
        lifecycleOwnerId: expiredOperation.ownerId,
        lifecycleFenceToken: expiredOperation.fenceToken,
      });

      await getReconcileExpiredLifecycleOperations(policy)();

      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: session.id,
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
      }));
    });

    it('completes an expired draining reset instead of cancelling it', async () => {
      const session = createSession();
      const expiredOperation = {
        sandboxSessionId: session.id,
        operation: 'reset',
        operationId: 'logical-reset-draining',
        phase: 'draining',
        ownerId: 'dead-owner',
        fenceToken: 1,
        allowedTurnId: 'terminal-turn',
        allowedDeliveryOwnerId: 'dead-delivery-owner',
        allowedDeliveryFenceToken: 3,
        leaseExpiresAt: Date.now() - 1,
        updatedAt: Date.now() - 1,
      };
      mockDb.getRecoverableSandboxSessionLifecycleOperations.mockResolvedValue([
        expiredOperation,
      ]);
      mockDb.claimSandboxSessionLifecycleOperation.mockImplementation(
        async (input) => ({
          ...expiredOperation,
          ownerId: input.ownerId,
          fenceToken: 2,
          leaseExpiresAt: Date.now() + input.leaseDurationMs,
          updatedAt: Date.now(),
        }),
      );
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockDb.getCheckpointV2.mockResolvedValue(null);

      await getReconcileExpiredLifecycleOperations(policy)();

      expect(
        mockDb.cancelSandboxSessionLifecycleOperation,
      ).not.toHaveBeenCalled();
      expect(
        mockDb.markSandboxSessionLifecycleOperationExecuting,
      ).toHaveBeenCalledOnce();
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: session.id,
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
      }));
    });

    it('delegates expired restore reconciliation, then evicts and cleans local state', async () => {
      const staleUpdatedAt = Date.now() - 300_000;
      const checkpointed = createSession({
        id: 'restore-checkpointed',
        status: 'RESTORING',
        updatedAt: staleUpdatedAt,
      });
      const terminated = createSession({
        id: 'restore-terminated',
        status: 'RESTORING',
        updatedAt: staleUpdatedAt,
      });
      mockDb.getRestoringSandboxSessions.mockResolvedValue([checkpointed, terminated]);
      mockDb.getExpiredSandboxSessionRestores.mockResolvedValue([
        checkpointed,
        terminated,
      ]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'expired-restore-runtime',
          containerName: 'expired-restore-runtime',
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': checkpointed.id,
          },
        }),
      ]);
      mockReconcileExpiredSandboxSessionRestore
        .mockResolvedValueOnce('CHECKPOINTED')
        .mockResolvedValueOnce('TERMINATED');
      const entries = Reflect.get(policy, 'entries') as Map<string, unknown>;
      entries.set(checkpointed.id, { state: 'none' });
      entries.set(terminated.id, { state: 'none' });

      await getReconcileOnStartup(policy)();

      expect(mockDb.getRestoringSandboxSessions).toHaveBeenCalledOnce();
      expect(
        mockReconcileExpiredSandboxSessionRestore,
      ).toHaveBeenNthCalledWith(1, checkpointed);
      expect(
        mockReconcileExpiredSandboxSessionRestore,
      ).toHaveBeenNthCalledWith(2, terminated);
      expect(mockOnSessionEvicted).toHaveBeenCalledWith(checkpointed.id, checkpointed.conversationId);
      expect(mockOnSessionEvicted).toHaveBeenCalledWith(terminated.id, terminated.conversationId);
      expect(entries.has(checkpointed.id)).toBe(false);
      expect(entries.has(terminated.id)).toBe(false);
    });

    it('does not reconcile a newer restore generation from an expired snapshot', async () => {
      const expiredGeneration = createSession({
        id: 'restore-generation-race',
        status: 'RESTORING',
        restoreFenceToken: 4,
      });
      const currentGeneration = createSession({
        id: expiredGeneration.id,
        status: 'RESTORING',
        restoreFenceToken: 5,
      });
      mockDb.getRestoringSandboxSessions.mockResolvedValue([
        currentGeneration,
      ]);
      mockDb.getExpiredSandboxSessionRestores.mockResolvedValue([
        expiredGeneration,
      ]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'current-restore-runtime',
          containerName: 'current-restore-runtime',
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': currentGeneration.id,
          },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(
        mockReconcileExpiredSandboxSessionRestore,
      ).not.toHaveBeenCalled();
      expect(mockOnSessionEvicted).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalledWith(
        'current-restore-runtime',
        expect.anything(),
      );
    });

    it('does not orphan-clean a fresh RESTORING runtime after container startup grace', async () => {
      const now = Date.now();
      const restoring = createSession({
        id: 'restore-owned-by-peer',
        status: 'RESTORING',
        updatedAt: now,
      });
      mockDb.getRestoringSandboxSessions.mockResolvedValue([restoring]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'restore-container',
          containerName: 'restore-container',
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': restoring.id,
            'ctxmill.started-at': new Date(now - 100_000).toISOString(),
          },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(
        mockReconcileExpiredSandboxSessionRestore,
      ).not.toHaveBeenCalled();
      expect(mockOnSessionEvicted).not.toHaveBeenCalledWith(
        restoring.id,
        restoring.conversationId,
      );
      expect(mockContainerManager.stopContainer).not.toHaveBeenCalledWith(
        'restore-container',
        expect.anything(),
      );
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalledWith(
        'restore-container',
        expect.anything(),
      );
    });

    it('re-reads live session status before startup orphan cleanup', async () => {
      const restoring = createSession({
        id: 'restore-after-snapshot',
        status: 'RESTORING',
      });
      mockDb.getRestoringSandboxSessions.mockResolvedValue([]);
      mockDb.getSandboxSession.mockResolvedValue(restoring);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'restore-after-snapshot-container',
          containerName: 'restore-after-snapshot-container',
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': restoring.id,
            'ctxmill.started-at': new Date(
              Date.now() - 180_000,
            ).toISOString(),
          },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockContainerManager.stopContainer).not.toHaveBeenCalledWith(
        'restore-after-snapshot-container',
        expect.anything(),
      );
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalledWith(
        'restore-after-snapshot-container',
        expect.anything(),
      );
    });

    it('reconcileOnStartup removes dead containers that were checkpointed during startup reconciliation', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([
        createSession({
          containerId: 'container-dead',
          containerName: 'ctxmill-sandbox-session-1',
          status: 'ACTIVE',
        }),
      ]);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-dead',
          containerName: 'ctxmill-sandbox-session-1',
          status: 'dead',
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('container-dead', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('container-dead', true);
    });

    it('reconcileOnStartup still removes a dead container when stop fails', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([
        createSession({
          containerId: 'container-dead',
          containerName: 'ctxmill-sandbox-session-1',
          status: 'ACTIVE',
        }),
      ]);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockContainerManager.stopContainer.mockRejectedValueOnce({ statusCode: 500, message: 'stop failed' });
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-dead',
          containerName: 'ctxmill-sandbox-session-1',
          status: 'dead',
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('container-dead', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('container-dead', true);
    });

    it('reconcileOnStartup matches a live container by persisted session-id label when runtime metadata is missing', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([
        createSession({
          containerId: null,
          containerName: null,
          status: 'ACTIVE',
        }),
      ]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-live',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);
      mockDb.getSandboxSession.mockResolvedValue(createSession({
        containerId: 'container-live',
        containerName: 'ctxmill-sandbox-session-1',
      }));

      await getReconcileOnStartup(policy)();

      expect(mockDb.updateSandboxSessionMetadata).toHaveBeenCalledWith(
        'session-1',
        'ACTIVE',
        expect.objectContaining({
          containerId: 'container-live',
          containerName: 'ctxmill-sandbox-session-1',
        }),
        {
          restoreFenceToken: 0,
          containerId: null,
        },
      );
      expect(grpcSessionClientMocks.waitForContainerReady).toHaveBeenCalledWith(
        'http://ctxmill-sandbox-session-1:50051',
        {
          runtimeInstanceToken: 'runtime-instance-token-1',
          signal: expect.anything(),
        },
      );
      expect(mockOnSessionReconnected).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'session-1',
          containerId: 'container-live',
          containerName: 'ctxmill-sandbox-session-1',
        }),
        expect.any(Object),
      );
      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('fails closed instead of adopting a live container whose instance token cannot be recovered', async () => {
      const session = createSession();
      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          labels: { 'ctxmill.sandbox-session-id': session.id },
        }),
      ]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockContainerManager.getRuntimeInstanceToken.mockResolvedValue(undefined);

      await getReconcileOnStartup(policy)();

      expect(
        mockContainerManager.getRuntimeInstanceToken,
      ).toHaveBeenCalledWith('container-1');
      expect(
        grpcSessionClientMocks.waitForContainerReady,
      ).not.toHaveBeenCalled();
      expect(mockOnSessionReconnected).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('live container has no runtime instance token'),
      );
    });

    it('marks a live delivery container known without adopting it on a second replica startup', async () => {
      const now = Date.UTC(2026, 6, 19, 13, 0, 0);
      vi.setSystemTime(now);
      mockDb.getActiveSandboxSessions.mockResolvedValue([
        createSession({
          containerId: null,
          containerName: null,
          status: 'ACTIVE',
        }),
      ]);
      mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-live',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockDb.hasLiveTurnDeliveryForSandboxSession).toHaveBeenCalledWith('session-1');
      expect(mockDb.updateSandboxSessionMetadata).not.toHaveBeenCalled();
      expect(grpcSessionClientMocks.waitForContainerReady).not.toHaveBeenCalled();
      expect(mockOnSessionReconnected).not.toHaveBeenCalled();
      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('does not adopt a live sandbox owned by an unfinished lifecycle operation', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([createSession()]);
      mockDb.hasUnfinishedSandboxSessionLifecycleOperation.mockResolvedValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);
      mockDb.getSandboxSession.mockResolvedValue(createSession());

      await getReconcileOnStartup(policy)();

      expect(
        mockDb.hasUnfinishedSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith('session-1');
      expect(grpcSessionClientMocks.waitForContainerReady).not.toHaveBeenCalled();
      expect(mockOnSessionReconnected).not.toHaveBeenCalled();
      expect(mockDb.updateSandboxSessionMetadata).not.toHaveBeenCalled();
      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('recovers a lifecycle operation promptly when its lease expires just after startup', async () => {
      const session = createSession();
      const expiredOperation = {
        sandboxSessionId: session.id,
        operation: 'terminate',
        operationId: 'logical-terminate-near-expiry',
        phase: 'executing',
        ownerId: 'dead-owner',
        fenceToken: 1,
        allowedTurnId: null,
        allowedDeliveryOwnerId: null,
        allowedDeliveryFenceToken: null,
        leaseExpiresAt: Date.now() + 1,
        updatedAt: Date.now(),
      };
      mockDb.getRecoverableSandboxSessionLifecycleOperations
        .mockResolvedValueOnce([])
        .mockResolvedValue([expiredOperation]);
      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockDb.hasUnfinishedSandboxSessionLifecycleOperation.mockResolvedValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          labels: { 'ctxmill.sandbox-session-id': session.id },
        }),
      ]);
      mockDb.claimSandboxSessionLifecycleOperation.mockImplementation(
        async (input) => ({
          ...expiredOperation,
          ownerId: input.ownerId,
          fenceToken: 2,
          leaseExpiresAt: Date.now() + input.leaseDurationMs,
          updatedAt: Date.now(),
        }),
      );
      mockDb.getSandboxSession.mockResolvedValue(session);

      await policy.start();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: session.id,
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
      }));
    });

    it('does not demote an ACTIVE session whose live delivery container is not visible to this replica', async () => {
      const now = Date.UTC(2026, 6, 19, 13, 30, 0);
      vi.setSystemTime(now);
      mockDb.getActiveSandboxSessions.mockResolvedValue([createSession()]);
      mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([]);

      await getReconcileOnStartup(policy)();

      expect(mockDb.hasLiveTurnDeliveryForSandboxSession).toHaveBeenCalledWith('session-1');
      expect(mockDb.getCheckpointV2).not.toHaveBeenCalled();
      expect(mockDb.updateSandboxSessionMetadata).not.toHaveBeenCalled();
      expect(mockOnSessionEvicted).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('adopts an ACTIVE live container once its delivery lease is expired or its turn is terminal', async () => {
      const now = Date.UTC(2026, 6, 19, 14, 0, 0);
      vi.setSystemTime(now);
      mockDb.getActiveSandboxSessions.mockResolvedValue([createSession()]);
      mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValue(false);
    mockDb.hasQueuedTurnsForSandboxSession.mockResolvedValue(false);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);
      mockDb.getSandboxSession.mockResolvedValue(createSession());

      await getReconcileOnStartup(policy)();

      expect(mockDb.hasLiveTurnDeliveryForSandboxSession).toHaveBeenCalledWith('session-1');
      expect(grpcSessionClientMocks.waitForContainerReady).toHaveBeenCalledOnce();
      expect(mockOnSessionReconnected).toHaveBeenCalledOnce();
    });

    it('does not reconnect a stale generation that changes while gRPC becomes ready', async () => {
      const observed = createSession({
        containerId: 'container-generation-1',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 1,
      });
      const successor = createSession({
        containerId: 'container-generation-2',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 2,
      });
      mockDb.getActiveSandboxSessions.mockResolvedValue([observed]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-generation-1',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);
      grpcSessionClientMocks.waitForContainerReady.mockImplementationOnce(
        async () => {
          mockDb.getSandboxSession.mockResolvedValue(successor);
          return {
            grpcClient: { killSession: vi.fn() },
            transport: {},
          };
        },
      );

      await getReconcileOnStartup(policy)();

      expect(grpcSessionClientMocks.waitForContainerReady).toHaveBeenCalledOnce();
      expect(mockOnSessionReconnected).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('skipping stale startup adoption'),
      );
    });

    it('holds durable adoption ownership through readiness and the cache callback', async () => {
      const session = createSession({
        containerId: 'container-adopted',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 4,
      });
      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-adopted',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': session.id },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockDb.claimSandboxSessionLifecycleOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSessionId: session.id,
          operation: 'adopt',
          expectedActiveGeneration: {
            restoreFenceToken: 4,
            containerId: 'container-adopted',
          },
        }),
      );
      expect(mockOnSessionReconnected).toHaveBeenCalledOnce();
      expect(mockDb.cancelSandboxSessionLifecycleOperation).toHaveBeenCalledOnce();
      const claimOrder =
        mockDb.claimSandboxSessionLifecycleOperation.mock.invocationCallOrder[0]!;
      const readinessOrder =
        grpcSessionClientMocks.waitForContainerReady.mock.invocationCallOrder[0]!;
      const cacheOrder = mockOnSessionReconnected.mock.invocationCallOrder[0]!;
      const cancelOrder =
        mockDb.cancelSandboxSessionLifecycleOperation.mock.invocationCallOrder[0]!;
      expect(claimOrder).toBeLessThan(readinessOrder);
      expect(readinessOrder).toBeLessThan(cacheOrder);
      expect(cacheOrder).toBeLessThan(cancelOrder);
      expect(mockReconnectionRevoke).not.toHaveBeenCalled();
    });

    it('revokes the exact cache registration when adoption ownership is lost during handoff', async () => {
      const session = createSession({
        containerId: 'container-adopted',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 4,
      });
      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-adopted',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': session.id },
        }),
      ]);
      mockDb.cancelSandboxSessionLifecycleOperation.mockResolvedValue(false);

      await getReconcileOnStartup(policy)();

      expect(mockOnSessionReconnected).toHaveBeenCalledOnce();
      expect(mockReconnectionRevoke).toHaveBeenCalledOnce();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'rolled back startup adoption after ownership loss',
        ),
      );
    });

    it('preserves the registered cache and idle monitor when cancellation committed but its response was lost', async () => {
      const session = createSession({
        containerId: 'container-adopted',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 4,
      });
      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-adopted',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': session.id },
        }),
      ]);
      mockDb.cancelSandboxSessionLifecycleOperation.mockRejectedValue(
        new Error('response lost'),
      );
      mockDb.hasUnfinishedSandboxSessionLifecycleOperation.mockResolvedValue(
        false,
      );

      await getReconcileOnStartup(policy)();

      expect(mockOnSessionReconnected).toHaveBeenCalledOnce();
      expect(mockReconnectionRevoke).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'authoritative readback confirmed release',
        ),
        expect.any(Error),
      );
    });

    it('revokes the registered predecessor when cancellation fails and readback shows a successor', async () => {
      const predecessor = createSession({
        containerId: 'container-generation-1',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 4,
      });
      const successor = createSession({
        containerId: 'container-generation-2',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 5,
      });
      mockDb.getActiveSandboxSessions.mockResolvedValue([predecessor]);
      mockDb.getSandboxSession
        .mockResolvedValueOnce(predecessor)
        .mockResolvedValue(successor);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-generation-1',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': predecessor.id },
        }),
      ]);
      mockDb.cancelSandboxSessionLifecycleOperation.mockRejectedValue(
        new Error('response lost after takeover'),
      );
      mockDb.hasUnfinishedSandboxSessionLifecycleOperation.mockResolvedValue(
        false,
      );

      await getReconcileOnStartup(policy)();

      expect(mockOnSessionReconnected).toHaveBeenCalledOnce();
      expect(mockReconnectionRevoke).toHaveBeenCalledOnce();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'authoritative readback did not confirm release',
        ),
        expect.any(Error),
      );
    });

    it('fails startup closed and revokes the registration when cancellation readback is unavailable', async () => {
      const session = createSession({
        containerId: 'container-adopted',
        containerName: 'ctxmill-sandbox-session-1',
        restoreFenceToken: 4,
      });
      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession
        .mockResolvedValueOnce(session)
        .mockRejectedValue(new Error('readback unavailable'));
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-adopted',
          containerName: 'ctxmill-sandbox-session-1',
          labels: { 'ctxmill.sandbox-session-id': session.id },
        }),
      ]);
      mockDb.cancelSandboxSessionLifecycleOperation.mockRejectedValue(
        new Error('cancellation response unavailable'),
      );

      await expect(getReconcileOnStartup(policy)()).rejects.toThrow(
        'Could not classify startup adoption cancellation',
      );

      expect(mockReconnectionRevoke).toHaveBeenCalledOnce();
    });

    it('reconcileOnStartup preserves recent unowned startup containers', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'startup-live',
          containerName: 'ctxmill-sandbox-startup-live',
          status: 'created',
          labels: {
            'ctxmill.sandbox-session-id': 'startup-session',
            'ctxmill.started-at': new Date(Date.now() - 1_000).toISOString(),
            'ctxmill.startup-grace-ms': '60000',
          },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('start calls reconcileOnStartup then starts periodic timer', async () => {
      const reconcileOnStartup = vi.spyOn(
        policy as unknown as { reconcileOnStartup: () => Promise<void> },
        'reconcileOnStartup',
      );
      const runReconciliation = vi.spyOn(
        policy as unknown as { runReconciliation: () => Promise<void> },
        'runReconciliation',
      );

      await policy.start();
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.reconciliationIntervalMs);

      expect(reconcileOnStartup).toHaveBeenCalledTimes(1);
      expect(runReconciliation).toHaveBeenCalledTimes(1);
    });

    it('uses updated reconciliationIntervalMs and clears the old periodic timer', async () => {
      const runReconciliation = vi.spyOn(
        policy as unknown as { runReconciliation: () => Promise<void> },
        'runReconciliation',
      );

      await policy.start();
      policy.updateConfig({ reconciliationIntervalMs: 120_000 });

      await vi.advanceTimersByTimeAsync(TEST_CONFIG.reconciliationIntervalMs);
      expect(runReconciliation).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runReconciliation).toHaveBeenCalledTimes(1);
    });

    it('stop clears timer and calls cleanupAll', async () => {
      const runReconciliation = vi.spyOn(
        policy as unknown as { runReconciliation: () => Promise<void> },
        'runReconciliation',
      );
      const cleanupAll = vi.spyOn(policy, 'cleanupAll');

      await policy.start();
      policy.stop();
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.reconciliationIntervalMs);

      expect(cleanupAll).toHaveBeenCalled();
      expect(runReconciliation).not.toHaveBeenCalled();
    });

    it('periodic reconciliation preserves a peer-owned RESTORING runtime', async () => {
      const restoring = createSession({
        id: 'restore-owned-by-peer',
        status: 'RESTORING',
      });
      mockDb.getRestoringSandboxSessions.mockResolvedValue([restoring]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'restore-container',
          containerName: 'restore-container',
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': restoring.id,
          },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(
        mockReconcileExpiredSandboxSessionRestore,
      ).not.toHaveBeenCalled();
      expect(mockContainerManager.stopContainer).not.toHaveBeenCalledWith(
        'restore-container',
        expect.anything(),
      );
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalledWith(
        'restore-container',
        expect.anything(),
      );
    });

    it('runReconciliation detects dead containers and calls shouldKillContainer', async () => {
      const session = createSession();
      const shouldKillContainer = vi.spyOn(
        policy as unknown as {
          shouldKillContainer: (containerId: string, sessionId?: string) => Promise<'kill' | 'kill-after-checkpoint' | 'skip'>;
        },
        'shouldKillContainer',
      );

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          status: 'dead',
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(shouldKillContainer).toHaveBeenCalledWith('container-1', 'session-1');
    });

    it('runReconciliation removes dead checkpointed containers after promoting the session', async () => {
      const session = createSession({
        containerId: 'container-dead',
        containerName: 'ctxmill-sandbox-session-1',
      });

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-dead',
          containerName: 'ctxmill-sandbox-session-1',
          status: 'dead',
          labels: { 'ctxmill.sandbox-session-id': 'session-1' },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: 'session-1',
        fromStatus: 'ACTIVE',
        toStatus: 'CHECKPOINTED',
        extra: expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
      }));
      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('container-dead', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('container-dead', true);
    });

    it('runReconciliation releases in-memory slots for externally removed active containers', async () => {
      const session = createSession({
        containerId: 'externally-removed',
        containerName: 'ctxmill-sandbox-session-1',
      });

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getSandboxSession.mockResolvedValue(session);
      mockDb.getCheckpointV2.mockResolvedValue(null);
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([]);

      await getRunReconciliation(policy)();

      expect(
        mockDb.completeSandboxSessionLifecycleOperation,
      ).toHaveBeenCalledWith(expect.objectContaining({
        sandboxSessionId: 'session-1',
        fromStatus: 'ACTIVE',
        toStatus: 'TERMINATED',
        extra: expect.objectContaining({
          containerId: null,
          containerName: null,
        }),
      }));
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('externally-removed', true);
    });

    it('containers with active unexpired sessions skip timeout-based cleanup', async () => {
      const session = createSession();

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockContainerManager.isContainerAlive.mockResolvedValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': 'session-1',
            'ctxmill.timeout': '3600',
            'ctxmill.started-at': new Date(Date.now() - 10_000).toISOString(),
          },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('enforces the hard lifetime on a live container whose active session expired (ctx-vsf8)', async () => {
      const session = createSession();

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValue(false);
      mockContainerManager.isContainerAlive.mockResolvedValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': 'session-1',
            'ctxmill.timeout': '1',
            'ctxmill.started-at': new Date(Date.now() - 10_000).toISOString(),
          },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('container-1', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('container-1', true);
    });

    it('defers hard-lifetime cleanup while a turn delivery is live', async () => {
      const session = createSession();

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.hasLiveTurnDeliveryForSandboxSession.mockResolvedValue(true);
      mockContainerManager.isContainerAlive.mockResolvedValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': 'session-1',
            'ctxmill.timeout': '1',
            'ctxmill.started-at': new Date(Date.now() - 10_000).toISOString(),
          },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('removes live managed containers with no active DB session', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'orphan-live',
          containerName: 'ctxmill-sandbox-orphan-live',
          status: 'running',
          labels: { 'ctxmill.sandbox-session-id': 'orphan-session' },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('orphan-live', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('orphan-live', true);
    });

    it('keeps live managed startup containers without an active DB session during startup grace without holding capacity', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([]);
      mockContainerManager.releaseContainerSlot.mockReturnValue(true);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'startup-live',
          containerName: 'ctxmill-sandbox-startup-live',
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': 'startup-session',
            'ctxmill.started-at': new Date(Date.now() - 10_000).toISOString(),
            'ctxmill.startup-grace-ms': '60000',
          },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.releaseContainerSlot).toHaveBeenCalledWith('startup-live');
    });

    it('removes stale managed startup containers after startup grace expires', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'startup-stale',
          containerName: 'ctxmill-sandbox-startup-stale',
          status: 'running',
          labels: {
            'ctxmill.sandbox-session-id': 'startup-session',
            'ctxmill.started-at': new Date(Date.now() - 70_000).toISOString(),
            'ctxmill.startup-grace-ms': '60000',
          },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('startup-stale', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('startup-stale', true);
    });

    it('removes live managed containers even when stop fails', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([]);
      mockContainerManager.stopContainer.mockRejectedValueOnce({ statusCode: 500, message: 'stop failed' });
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'orphan-live',
          containerName: 'ctxmill-sandbox-orphan-live',
          status: 'running',
          labels: { 'ctxmill.sandbox-session-id': 'orphan-session' },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('orphan-live', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('orphan-live', true);
    });
  });

  describe('cleanup', () => {
    it('cleanup(sessionId) clears all timers for that session', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      policy.cleanup('session-1');

      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
      expect(policy.getState('session-1')).toBe('none');
    });

    it('cleanupAll() clears all entries', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-2', 'container-2', callbacks);
      policy.cleanupAll();

      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
      expect(policy.getState('session-1')).toBe('none');
      expect(policy.getState('session-2')).toBe('none');
    });
  });

  it('reconcileOnStartup is available for session recovery integration', async () => {
    mockDb.getActiveSandboxSessions.mockResolvedValue([createSession()]);
    mockContainerManager.listManagedContainers.mockResolvedValue([createContainer()]);

    await expect(getReconcileOnStartup(policy)()).resolves.toBeUndefined();
  });
});
