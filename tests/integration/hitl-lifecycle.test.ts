import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';
import { TestSessionRegistry } from '../utils/test-session-registry.js';
import type {
  InterruptRow,
} from '../../packages/ctxmill/src/database/repository.js';
import {
  createTestBus,
  collectEvents,
} from '../utils/event-bus-test-helpers.js';

type InterruptStore = NonNullable<ConstructorParameters<typeof InterruptManager>[1]>;
type InterruptInsert = Parameters<InterruptStore['savePendingInterrupt']>[0];

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
    markInterruptTimedOut: vi.fn(async (id: string, data?: unknown) => {
      const row = rows.get(id);
      if (!row) {
        return undefined;
      }
      const updated: InterruptRow = {
        ...row,
        status: 'timed_out',
        resolvedAt: Date.now(),
        resolvedAction: 'timeout',
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
describe('HITL lifecycle boundary conditions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('HITL wait state transitions', () => {
    it('keeps the session ACTIVE while waiting for approval', async () => {
      const registry = new TestSessionRegistry(undefined, createTestBus());
      const onTimeout = vi.fn().mockResolvedValue(undefined);
      const manager = new InterruptManager(createTestBus(), undefined, onTimeout);
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      const approval = manager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'send_email',
        { to: 'user@example.com' },
        1_000,
        run.id,
      );

      await vi.advanceTimersByTimeAsync(500);

      expect(registry.getRun(run.id)?.status).toBe('running');
      expect(onTimeout).not.toHaveBeenCalled();

      await expect(manager.resolve('run-1', 'approve', { ok: true }, 'agent-1')).resolves.toBe(true);
      await expect(approval).resolves.toEqual({ action: 'approve', data: { ok: true } });
      expect(registry.getRun(run.id)?.status).toBe('running');

      manager.shutdown();
    });

    it('on timeout fires onTimeout and suspends the session', async () => {
      const registry = new TestSessionRegistry(undefined, createTestBus());
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const onTimeout = vi.fn(async (sessionId: string) => {
        await registry.suspendSession(sessionId, 'hitl_timeout');
      });
      const manager = new InterruptManager(createTestBus(), undefined, onTimeout);

      const approval = manager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'bash',
        { cmd: 'ls' },
        1_000,
        run.id,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();

      await expect(approval).resolves.toMatchObject({ action: 'suspend' });
      expect(onTimeout).toHaveBeenCalledWith(run.id);
      expect(registry.getRun(run.id)?.status).toBe('suspended');
      expect(registry.getRun(run.id)?.pausedReason).toBe('hitl_timeout');

      manager.shutdown();
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

      await expect(manager.resolve('run-1', 'approve', { ok: true }, 'agent-1')).resolves.toBe(true);
      await expect(approval).resolves.toEqual({ action: 'approve', data: { ok: true } });
      expect(manager.hasPending('run-1')).toBe(false);

      interruptedEvents.unsubscribe();
      manager.shutdown();
    });

    it('waitForApproval suspends after configured duration', async () => {
      const manager = new InterruptManager(createTestBus());
      const approval = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 1_000);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(approval).resolves.toMatchObject({ action: 'suspend' });
      expect(manager.hasPending('run-1')).toBe(false);

      manager.shutdown();
    });

    it('resolve on unknown runId returns false', async () => {
      const manager = new InterruptManager(createTestBus());

      await expect(manager.resolve('missing-run', 'approve')).resolves.toBe(false);

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

      await expect(manager.resolve('run-1', 'approve', { ok: true }, 'agent-1')).resolves.toBe(true);
      await expect(second).resolves.toEqual({ action: 'approve', data: { ok: true } });

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

      await expect(
        manager.resolveForSession('session-1', 'suspend', 'Session suspended for HITL approval — awaiting human decision'),
      ).resolves.toBe(true);

      await expect(approval).resolves.toEqual({
        action: 'suspend',
        data: 'Session suspended for HITL approval — awaiting human decision',
      });
      expect(manager.hasPending('run-1')).toBe(false);

      manager.shutdown();
    });

    it('resolveForSession returns false for unknown sessionId', async () => {
      const manager = new InterruptManager(createTestBus());

      await expect(manager.resolveForSession('no-such-session', 'suspend')).resolves.toBe(false);

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
      await Promise.resolve();

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(restartedManager.hasPending('run-1')).toBe(true);
      await expect(restartedManager.resolve('run-1', 'approve', 'approved', 'agent-1')).resolves.toBe(true);
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
      await Promise.resolve();

      vi.setSystemTime(new Date('2026-03-25T12:00:02.000Z'));

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(rows.has('run-1')).toBe(false);
      expect(restartedManager.hasPending('run-1')).toBe(false);
      await expect(restartedManager.resolve('run-1', 'approve')).resolves.toBe(false);

      firstManager.shutdown();
      restartedManager.shutdown();
    });
  });

});
