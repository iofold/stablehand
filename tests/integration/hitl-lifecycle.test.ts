import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';
import { ContainerLifecyclePolicy } from '../../packages/ctxmill/src/orchestrator/container-lifecycle-policy.js';
import { TestSessionRegistry } from '../utils/test-session-registry.js';
import type { ContainerManager } from '../../packages/ctxmill/src/sandbox/container-manager.js';
import type {
  InterruptRow,
} from '../../packages/ctxmill/src/database/repository.js';
import {
  createTestBus,
  collectEvents,
} from '../utils/event-bus-test-helpers.js';

type InterruptStore = NonNullable<ConstructorParameters<typeof InterruptManager>[1]>;
type InterruptInsert = Parameters<InterruptStore['savePendingInterrupt']>[0];

function createMockContainerManager(): ContainerManager {
  return {
    pauseContainer: vi.fn().mockResolvedValue(undefined),
    unpauseContainer: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContainerManager;
}

function createPauseManager(
  overrides?: {
    pauseDelayMs?: number;
    maxPauseDurationMs?: number;
    idleTimeoutMs?: number;
    freezePromotionMs?: number;
    onPromoteToCheckpoint?: (sessionId: string) => Promise<void>;
  },
): {
  pauseManager: ContainerLifecyclePolicy;
  containerManager: ContainerManager;
  onPromoteToCheckpoint: ReturnType<typeof vi.fn>;
} {
  const containerManager = createMockContainerManager();
  const onPromoteToCheckpoint = overrides?.onPromoteToCheckpoint
    ? vi.fn().mockImplementation(overrides.onPromoteToCheckpoint)
    : vi.fn().mockResolvedValue(undefined);
  const mockDb = {
    getActiveSandboxSessions: vi.fn().mockResolvedValue([]),
    updateSandboxSessionStatus: vi.fn().mockResolvedValue(undefined),
    getCheckpointV2: vi.fn().mockResolvedValue(null),
    deleteSandboxSession: vi.fn().mockResolvedValue(undefined),
  } as any;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const pauseManager = new ContainerLifecyclePolicy({
    containerManager,
    db: mockDb,
    logger: mockLogger,
    config: {
      pauseDelayMs: overrides?.pauseDelayMs ?? 5_000,
      maxPauseDurationMs: overrides?.maxPauseDurationMs ?? 300_000,
      idleTimeoutMs: overrides?.idleTimeoutMs ?? 300_000,
      freezePromotionMs: overrides?.freezePromotionMs ?? 600_000,
    },
    onPromoteToCheckpoint,
    reconciliationCallbacks: {
      onSessionReconnected: vi.fn(),
      onSessionEvicted: vi.fn(),
    },
  });

  return { pauseManager, containerManager, onPromoteToCheckpoint };
}

function createMockInterruptDb(): {
  db: InterruptStore;
  rows: Map<string, InterruptRow>;
} {
  const rows = new Map<string, InterruptRow>();

  const toRow = (data: InterruptInsert): InterruptRow => ({
    id: data.id,
    agentSessionId: data.agentSessionId,
    agentId: data.agentId,
    sessionId: data.sessionId ?? null,
    toolCallId: data.toolCallId ?? '',
    toolName: data.toolName ?? '',
    args: data.args ?? {},
    timeoutMs: data.timeoutMs ?? 0,
    createdAt: data.createdAt ?? Date.now(),
    expiresAt: data.expiresAt ?? Date.now(),
    resolvedAt: data.resolvedAt ?? null,
    resolvedAction: data.resolvedAction ?? null,
    resolvedData: data.resolvedData ?? null,
    status: data.status ?? 'pending',
  });

  const db: InterruptStore = {
    savePendingInterrupt: vi.fn(async (data: InterruptInsert) => {
      const row = toRow(data);
      rows.set(row.id, row);
      return row;
    }),
    resolveInterrupt: vi.fn(async (id: string, action: string, data?: unknown) => {
      const row = rows.get(id);
      if (!row) {
        return undefined;
      }

      const updated: InterruptRow = {
        ...row,
        status: 'resolved',
        resolvedAt: Date.now(),
        resolvedAction: action,
        resolvedData: data ?? null,
      };
      rows.set(id, updated);
      return updated;
    }),
    cleanupExpiredInterrupts: vi.fn(async (beforeTime: number) => {
      let deleted = 0;
      for (const [id, row] of rows) {
        if (row.status === 'pending' && (row.expiresAt ?? 0) < beforeTime) {
          rows.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    }),
    getAllPendingInterrupts: vi.fn(async () => {
      return Array.from(rows.values()).filter((row) => row.status === 'pending');
    }),
  };

  return { db, rows };
}
async function waitForHitlThenScheduleIdleTimeout(
  interrupts: InterruptManager,
  pauseManager: ContainerLifecyclePolicy,
  sessionId: string,
  containerId: string,
): Promise<void> {
  pauseManager.schedulePause(sessionId, containerId);
  await interrupts.waitForApproval(
    'run-1',
    'agent-1',
    'tc-1',
    'send_email',
    { to: 'user@example.com' },
    60_000,
  );
  await pauseManager.cancelPause(sessionId);
  pauseManager.scheduleIdleTimeout(sessionId, containerId, {
    onFreeze: vi.fn().mockResolvedValue(undefined),
    onCheckpoint: vi.fn().mockResolvedValue(undefined),
  });
}

describe('HITL lifecycle boundary conditions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('HITL pause/resume state transitions', () => {
    it('pauseRun sets status to paused and emits run.paused', async () => {
      const bus = createTestBus();
      const pausedEvents = collectEvents(bus, 'session.paused');
      const registry = new TestSessionRegistry(undefined, bus);
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      const paused = await registry.pauseRun(run.id, 'hitl_approval');

      expect(paused).toBeDefined();
      expect(paused?.status).toBe('paused');
      expect(paused?.pausedReason).toBe('hitl_approval');
      expect(pausedEvents.events).toHaveLength(1);
      expect(pausedEvents.events[0]).toEqual(
        expect.objectContaining({
          sessionId: run.id,
          agentId: 'agent-1',
          conversationId: 'conv-1',
          reason: 'hitl_approval',
        }),
      );

      pausedEvents.unsubscribe();
    });

    it('resumeRun after pauseRun transitions back to running', async () => {
      const registry = new TestSessionRegistry(undefined, createTestBus());
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      await registry.pauseRun(run.id, 'hitl_approval');
      const resumed = await registry.resumeRun(run.id);

      expect(resumed).toBeDefined();
      expect(resumed?.status).toBe('running');
      expect(resumed?.resumedAt).toBeTypeOf('number');
    });

    it('pauseRun on non-running run returns undefined', async () => {
      const registry = new TestSessionRegistry(undefined, createTestBus());
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      await registry.completeRun(run.id);

      await expect(registry.pauseRun(run.id, 'should_not_pause')).resolves.toBeUndefined();
    });
  });

  describe('InterruptManager lifecycle', () => {
    it('waitForApproval creates pending interrupt, resolve delivers approval', async () => {
      const bus = createTestBus();
      const interruptedEvents = collectEvents(bus, 'run.interrupted');
      const manager = new InterruptManager(bus);

      const approval = manager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'send_email',
        { to: 'user@example.com' },
      );

      expect(manager.hasPending('run-1')).toBe(true);
      expect(manager.getPending('run-1')).toEqual(
        expect.objectContaining({
          toolCallId: 'tc-1',
          toolName: 'send_email',
          args: { to: 'user@example.com' },
        }),
      );
      expect(interruptedEvents.events).toHaveLength(1);

      expect(manager.resolve('run-1', 'approve', { ok: true }, 'agent-1')).toBe(true);
      await expect(approval).resolves.toEqual({ action: 'approve', data: { ok: true } });
      expect(manager.hasPending('run-1')).toBe(false);

      interruptedEvents.unsubscribe();
      manager.shutdown();
    });

    it('waitForApproval times out after configured duration', async () => {
      const manager = new InterruptManager(createTestBus());
      const approval = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 1_000);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(approval).resolves.toMatchObject({ action: 'timeout' });
      expect(manager.hasPending('run-1')).toBe(false);

      manager.shutdown();
    });

    it('resolve on unknown runId returns false', () => {
      const manager = new InterruptManager(createTestBus());

      expect(manager.resolve('missing-run', 'approve')).toBe(false);

      manager.shutdown();
    });

    it('second waitForApproval supersedes first', async () => {
      const manager = new InterruptManager(createTestBus());

      const first = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'tool-a', {}, 60_000);
      const second = manager.waitForApproval('run-1', 'agent-1', 'tc-2', 'tool-b', {}, 60_000);

      await expect(first).resolves.toEqual({
        action: 'reject',
        data: 'Superseded by new interrupt',
      });

      expect(manager.resolve('run-1', 'approve', { ok: true }, 'agent-1')).toBe(true);
      await expect(second).resolves.toEqual({ action: 'approve', data: { ok: true } });

      manager.shutdown();
    });

    it('cancelTimeoutForSession prevents automatic timeout resolution', async () => {
      const manager = new InterruptManager(createTestBus());

      const approval = manager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'bash',
        { cmd: 'ls' },
        1_000,
        'session-1',
      );

      manager.cancelTimeoutForSession('session-1');

      await vi.advanceTimersByTimeAsync(2_000);

      expect(manager.hasPending('run-1')).toBe(true);

      expect(manager.resolve('run-1', 'approve')).toBe(true);
      await expect(approval).resolves.toEqual({ action: 'approve' });

      manager.shutdown();
    });

    it('resolveForSession resolves pending interrupt by sessionId', async () => {
      const manager = new InterruptManager(createTestBus());

      const approval = manager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'bash',
        {},
        60_000,
        'session-1',
      );

      expect(manager.resolveForSession('session-1', 'timeout', 'timed out by lifecycle')).toBe(true);

      await expect(approval).resolves.toEqual({
        action: 'timeout',
        data: 'timed out by lifecycle',
      });
      expect(manager.hasPending('run-1')).toBe(false);

      manager.shutdown();
    });

    it('resolveForSession returns false for unknown sessionId', () => {
      const manager = new InterruptManager(createTestBus());

      expect(manager.resolveForSession('no-such-session', 'timeout')).toBe(false);

      manager.shutdown();
    });
  });

  describe('InterruptManager restart survival', () => {
    it('loadFromDb reloads non-expired pending interrupts', async () => {
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));

      const { db } = createMockInterruptDb();
      const firstManager = new InterruptManager(undefined, db);
      firstManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 60_000);
      await Promise.resolve();

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(restartedManager.hasPending('run-1')).toBe(true);
      expect(restartedManager.resolve('run-1', 'approve', 'approved', 'agent-1')).toBe(true);
      expect(db.resolveInterrupt).toHaveBeenCalledWith('run-1', 'approve', 'approved');

      firstManager.shutdown();
      restartedManager.shutdown();
    });

    it('loadFromDb skips expired interrupts', async () => {
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));

      const { db, rows } = createMockInterruptDb();
      const firstManager = new InterruptManager(undefined, db);
      firstManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 1_000);
      await Promise.resolve();

      vi.setSystemTime(new Date('2026-03-25T12:00:02.000Z'));

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(rows.has('run-1')).toBe(false);
      expect(restartedManager.hasPending('run-1')).toBe(false);
      expect(restartedManager.resolve('run-1', 'approve')).toBe(false);

      firstManager.shutdown();
      restartedManager.shutdown();
    });
  });

  describe('PauseManager HITL flow', () => {
    it('schedulePause transitions to scheduled, then paused after delay', async () => {
      const { pauseManager, containerManager } = createPauseManager({ pauseDelayMs: 5_000 });

      pauseManager.schedulePause('sess-1', 'container-1');
      expect(pauseManager.getState('sess-1')).toBe('scheduled');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(pauseManager.getState('sess-1')).toBe('paused');
      expect(containerManager.pauseContainer).toHaveBeenCalledWith('container-1');

      pauseManager.cleanupAll();
    });

    it('cancelPause before pause executes cancels the schedule', async () => {
      const { pauseManager, containerManager } = createPauseManager({ pauseDelayMs: 5_000 });

      pauseManager.schedulePause('sess-1', 'container-1');
      await pauseManager.cancelPause('sess-1');
      await vi.advanceTimersByTimeAsync(10_000);

      expect(pauseManager.getState('sess-1')).toBe('none');
      expect(containerManager.pauseContainer).not.toHaveBeenCalled();
      expect(containerManager.unpauseContainer).not.toHaveBeenCalled();

      pauseManager.cleanupAll();
    });

    it('cancelPause after pause executes unpauses container', async () => {
      const { pauseManager, containerManager } = createPauseManager({ pauseDelayMs: 5_000 });

      pauseManager.schedulePause('sess-1', 'container-1');
      await vi.advanceTimersByTimeAsync(5_000);
      await pauseManager.cancelPause('sess-1');

      expect(pauseManager.getState('sess-1')).toBe('none');
      expect(containerManager.unpauseContainer).toHaveBeenCalledWith('container-1');

      pauseManager.cleanupAll();
    });

    it('HITL promotion fires after maxPauseDurationMs', async () => {
      const { pauseManager, onPromoteToCheckpoint } = createPauseManager({
        pauseDelayMs: 1_000,
        maxPauseDurationMs: 10_000,
      });

      pauseManager.schedulePause('sess-1', 'container-1');
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(onPromoteToCheckpoint).toHaveBeenCalledWith('sess-1');
      expect(pauseManager.getState('sess-1')).toBe('none');

      pauseManager.cleanupAll();
    });
  });

  describe('PauseManager + HITL coordination', () => {
    it('idle timeout is not scheduled during active HITL wait', async () => {
      const interrupts = new InterruptManager(createTestBus());
      const { pauseManager } = createPauseManager({ pauseDelayMs: 5_000 });
      const idleSpy = vi.spyOn(pauseManager, 'scheduleIdleTimeout');

      const turn = waitForHitlThenScheduleIdleTimeout(
        interrupts,
        pauseManager,
        'sess-1',
        'container-1',
      );

      await Promise.resolve();

      expect(pauseManager.getState('sess-1')).toBe('scheduled');
      expect(idleSpy).not.toHaveBeenCalled();

      expect(interrupts.resolve('run-1', 'approve', { ok: true }, 'agent-1')).toBe(true);
      await turn;

      expect(idleSpy).toHaveBeenCalledTimes(1);
      expect(idleSpy).toHaveBeenCalledWith(
        'sess-1',
        'container-1',
        expect.objectContaining({
          onFreeze: expect.any(Function),
          onCheckpoint: expect.any(Function),
        }),
      );

      interrupts.shutdown();
      pauseManager.cleanupAll();
    });

    it('lifecycle policy is sole timeout authority when interrupt timeout is cancelled', async () => {
      const interrupts = new InterruptManager(createTestBus());
      const { pauseManager, containerManager, onPromoteToCheckpoint } = createPauseManager({
        pauseDelayMs: 1_000,
        maxPauseDurationMs: 5_000,
      });

      const approval = interrupts.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'send_email',
        { to: 'a@b.com' },
        30_000,
        'sess-1',
      );

      interrupts.cancelTimeoutForSession('sess-1');

      pauseManager.schedulePause('sess-1', 'container-1');

      await vi.advanceTimersByTimeAsync(1_000);

      expect(containerManager.pauseContainer).toHaveBeenCalledWith('container-1');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(onPromoteToCheckpoint).toHaveBeenCalledWith('sess-1');

      expect(interrupts.resolveForSession('sess-1', 'timeout', 'checkpointed by lifecycle')).toBe(
        true,
      );

      await expect(approval).resolves.toEqual({
        action: 'timeout',
        data: 'checkpointed by lifecycle',
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(interrupts.hasPending('run-1')).toBe(false);

      interrupts.shutdown();
      pauseManager.cleanupAll();
    });
  });
});
