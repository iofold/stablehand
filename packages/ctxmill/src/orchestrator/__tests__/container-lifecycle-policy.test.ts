import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';

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
  createContainer: vi.fn(),
  startContainer: vi.fn(),
} as any;

const mockDb = {
  getActiveSandboxSessions: vi.fn(),
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
  return new ContainerLifecyclePolicy({
    containerManager: mockContainerManager,
    db: mockDb,
    logger: mockLogger,
    config: TEST_CONFIG,
    reconciliationCallbacks: {
      onSessionReconnected: mockOnSessionReconnected,
      onSessionEvicted: mockOnSessionEvicted,
    },
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
    grpcSessionClientMocks.waitForContainerReady.mockResolvedValue({
      grpcClient: { killSession: vi.fn() },
      transport: {},
    });

    mockDb.getActiveSandboxSessions.mockResolvedValue([]);
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

    it('cancelIdleTimeout clears idle timer', async () => {
      const callbacks = {
        onCheckpoint: vi.fn().mockResolvedValue(undefined),
      };

      policy.scheduleIdleTimeout('session-1', 'container-1', callbacks);
      await policy.cancelIdleTimeout('session-1');
      await vi.advanceTimersByTimeAsync(TEST_CONFIG.idleTimeoutMs);

      expect(callbacks.onCheckpoint).not.toHaveBeenCalled();
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
          pausedAt: null,
          pausedReason: null,
        }),
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
          pausedAt: null,
          pausedReason: null,
        }),
      );
      expect(mockOnSessionEvicted).toHaveBeenCalledWith('session-1', 'conversation-1');
    });
  });

  describe('reconciliation', () => {
    it('reconcileOnStartup converts legacy PAUSED session with checkpoint to CHECKPOINTED', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([
        createSession({ status: 'PAUSED', pausedAt: Date.now(), pausedReason: 'idle' }),
      ]);
      mockDb.getCheckpointV2.mockResolvedValue({ id: 'checkpoint-1' });
      mockContainerManager.listManagedContainers.mockResolvedValue([
        createContainer({ status: 'paused' }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'session-1',
        'CHECKPOINTED',
        expect.objectContaining({
          containerId: null,
          containerName: null,
          pausedAt: null,
          pausedReason: null,
        }),
      );
      expect(mockOnSessionEvicted).toHaveBeenCalledWith('session-1', 'conversation-1');
      expect(mockOnSessionReconnected).not.toHaveBeenCalled();
    });

    it('reconcileOnStartup converts legacy PAUSED session without checkpoint to TERMINATED', async () => {
      mockDb.getActiveSandboxSessions.mockResolvedValue([
        createSession({ status: 'PAUSED', pausedAt: Date.now(), pausedReason: 'idle' }),
      ]);
      mockDb.getCheckpointV2.mockResolvedValue(null);
      mockContainerManager.listManagedContainers.mockResolvedValue([
        createContainer({ status: 'paused' }),
      ]);

      await getReconcileOnStartup(policy)();

      expect(mockDb.updateSandboxSessionStatus).toHaveBeenCalledWith(
        'session-1',
        'TERMINATED',
        expect.objectContaining({
          containerId: null,
          containerName: null,
          pausedAt: null,
          pausedReason: null,
        }),
      );
      expect(mockOnSessionEvicted).toHaveBeenCalledWith('session-1', 'conversation-1');
      expect(mockOnSessionReconnected).not.toHaveBeenCalled();
    });

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
          pausedAt: null,
          pausedReason: null,
        }),
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
          pausedAt: null,
          pausedReason: null,
        }),
      );
      expect(mockContainerManager.stopContainer).toHaveBeenCalledWith('container-dead', 10);
      expect(mockContainerManager.removeContainer).toHaveBeenCalledWith('container-dead', true);
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
