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
} as any;

const mockDb = {
  getActiveSandboxSessions: vi.fn(),
  getStrandedRestoringSessions: vi.fn(),
  updateSandboxSessionStatus: vi.fn(),
  getCheckpointV2: vi.fn(),
  deleteSandboxSession: vi.fn(),
} as any;

const mockOnSessionReconnected = vi.fn();
const mockOnSessionEvicted = vi.fn().mockResolvedValue(undefined);

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
  return {
    id: 'session-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    containerId: 'container-1',
    containerName: 'container-1',
    status: 'ACTIVE',
    harnessName: 'test-harness',
    checkpointRef: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
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
    grpcSessionClientMocks.waitForContainerReady.mockResolvedValue({
      grpcClient: { killSession: vi.fn() },
      transport: {},
    });

    mockDb.getActiveSandboxSessions.mockResolvedValue([]);
    mockDb.getStrandedRestoringSessions.mockResolvedValue([]);
    mockDb.updateSandboxSessionStatus.mockResolvedValue(undefined);
    mockDb.getCheckpointV2.mockResolvedValue(null);
    mockDb.deleteSandboxSession.mockResolvedValue(undefined);

    mockOnSessionReconnected.mockReset();
    mockOnSessionEvicted.mockReset();

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
      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        session.id,
        'TERMINATED',
        expect.objectContaining({
        containerId: null,
        containerName: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
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
      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        session.id,
        'CHECKPOINTED',
        expect.objectContaining({
        containerId: null,
        containerName: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
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
      expect(mockDb.updateSandboxSessionStatus).not.toHaveBeenCalled();
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

    it('container alive returns skip', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);

      const conversationIds = Reflect.get(policy, 'sessionConversationIds') as Map<string, string>;
      conversationIds.set('session-1', 'conversation-1');

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('skip');
      expect(mockContainerManager.isContainerAlive).toHaveBeenCalledWith('container-1');
    });

    it('container dead with checkpoint marks CHECKPOINTED, evicts session, and returns kill-after-checkpoint', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);

      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });

      const conversationIds = Reflect.get(policy, 'sessionConversationIds') as Map<string, string>;
      conversationIds.set('session-1', 'conversation-1');

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('kill-after-checkpoint');
      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'session-1',
        'CHECKPOINTED',
        expect.objectContaining({
        containerId: null,
        containerName: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
      expect(mockOnSessionEvicted).toHaveBeenCalledWith('session-1', 'conversation-1');
    });

    it('container dead without checkpoint marks TERMINATED, evicts session, and returns kill', async () => {
      const shouldKillContainer = getShouldKillContainer(policy);

      mockContainerManager.isContainerAlive.mockResolvedValue(false);

      const conversationIds = Reflect.get(policy, 'sessionConversationIds') as Map<string, string>;
      conversationIds.set('session-1', 'conversation-1');

      await expect(shouldKillContainer('container-1', 'session-1')).resolves.toBe('kill');
      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'session-1',
        'TERMINATED',
        expect.objectContaining({
        containerId: null,
        containerName: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
      expect(mockOnSessionEvicted).toHaveBeenCalledWith('session-1', 'conversation-1');
    });
  });

  describe('reconciliation', () => {
    it('reconcileOnStartup removes dead containers that were checkpointed during startup reconciliation', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([
        createSession({
          containerId: 'container-dead',
          containerName: 'ctxmill-run-session-1',
          status: 'ACTIVE',
        }),
      ]);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-dead',
          containerName: 'ctxmill-run-session-1',
          status: 'dead',
          labels: { 'ctxmill.session-id': 'session-1' },
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
          containerName: 'ctxmill-run-session-1',
          status: 'ACTIVE',
        }),
      ]);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockContainerManager.stopContainer.mockRejectedValueOnce({ statusCode: 500, message: 'stop failed' });
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-dead',
          containerName: 'ctxmill-run-session-1',
          status: 'dead',
          labels: { 'ctxmill.session-id': 'session-1' },
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
          containerName: 'ctxmill-run-session-1',
          labels: { 'ctxmill.session-id': 'session-1' },
        }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'session-1',
        'ACTIVE',
        expect.objectContaining({
        containerId: 'container-live',
        containerName: 'ctxmill-run-session-1',
      }),
      { expectedFrom: 'ACTIVE' },
    );
      expect(grpcSessionClientMocks.waitForContainerReady).toHaveBeenCalledWith(
        'http://ctxmill-run-session-1:50051',
      );
      expect(mockOnSessionReconnected).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'session-1',
          containerId: 'container-live',
          containerName: 'ctxmill-run-session-1',
        }),
        expect.any(Object),
      );
      expect(mockContainerManager.stopContainer).not.toHaveBeenCalled();
      expect(mockContainerManager.removeContainer).not.toHaveBeenCalled();
    });

    it('reconcileOnStartup preserves recent unowned startup containers', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'startup-live',
          containerName: 'ctxmill-run-startup-live',
          status: 'created',
          labels: {
            'ctxmill.session-id': 'startup-session',
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

    it('runReconciliation detects dead containers and calls shouldKillContainer', async () => {
      const session = createSession();
      const shouldKillContainer = vi.spyOn(
        policy as unknown as {
          shouldKillContainer: (containerId: string, sessionId?: string) => Promise<'kill' | 'kill-after-checkpoint' | 'skip'>;
        },
        'shouldKillContainer',
      );

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          status: 'dead',
          labels: { 'ctxmill.session-id': 'session-1' },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(shouldKillContainer).toHaveBeenCalledWith('container-1', 'session-1');
    });

    it('runReconciliation removes dead checkpointed containers after promoting the session', async () => {
      const session = createSession({
        containerId: 'container-dead',
        containerName: 'ctxmill-run-session-1',
      });

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          containerId: 'container-dead',
          containerName: 'ctxmill-run-session-1',
          status: 'dead',
          labels: { 'ctxmill.session-id': 'session-1' },
        }),
      ]);

      await getRunReconciliation(policy)();

      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'session-1',
        'CHECKPOINTED',
        expect.objectContaining({
        containerId: null,
        containerName: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('container-dead', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('container-dead', true);
    });

    it('runReconciliation releases in-memory slots for externally removed active containers', async () => {
      const session = createSession({
        containerId: 'externally-removed',
        containerName: 'ctxmill-run-session-1',
      });

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockDb.getCheckpointV2.mockResolvedValue(null);
      mockContainerManager.isContainerAlive.mockResolvedValue(false);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([]);

      await getRunReconciliation(policy)();

      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'session-1',
        'TERMINATED',
        expect.objectContaining({
        containerId: null,
        containerName: null,
      }),
      { expectedFrom: 'ACTIVE' },
    );
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('externally-removed', true);
    });

    it('containers with active sessions skip timeout-based cleanup', async () => {
      const session = createSession();

      mockDb.getActiveSandboxSessions.mockResolvedValue([session]);
      mockContainerManager.listManagedContainersWithLabels.mockResolvedValue([
        createContainer({
          status: 'running',
          labels: {
            'ctxmill.session-id': 'session-1',
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
          containerName: 'ctxmill-run-orphan-live',
          status: 'running',
          labels: { 'ctxmill.session-id': 'orphan-session' },
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
          containerName: 'ctxmill-run-startup-live',
          status: 'running',
          labels: {
            'ctxmill.session-id': 'startup-session',
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
          containerName: 'ctxmill-run-startup-stale',
          status: 'running',
          labels: {
            'ctxmill.session-id': 'startup-session',
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
          containerName: 'ctxmill-run-orphan-live',
          status: 'running',
          labels: { 'ctxmill.session-id': 'orphan-session' },
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
