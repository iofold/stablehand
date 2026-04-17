import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';
import type { InterruptRow } from '../../packages/ctxmill/src/database/repository.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

type InterruptStore = NonNullable<ConstructorParameters<typeof InterruptManager>[1]>;
type InterruptInsert = Parameters<InterruptStore['savePendingInterrupt']>[0];

function createMockInterruptDb() {
  const rows = new Map<string, InterruptRow>();

  const toRow = (data: InterruptInsert): InterruptRow => ({
    id: data.id,
    agentSessionId: data.agentSessionId,
    agentId: data.agentId,
    sessionId: data.sessionId ?? null,
    toolCallId: data.toolCallId,
    toolName: data.toolName,
    args: data.args ?? {},
    timeoutMs: data.timeoutMs ?? 0,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
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
        if (row.status === 'pending' && row.expiresAt < beforeTime) {
          rows.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    }),
    getAllPendingInterrupts: vi.fn(async () => Array.from(rows.values()).filter((row) => row.status === 'pending')),
  };

  return { db, rows };
}

describe('InterruptManager', () => {
  let manager: InterruptManager;

  beforeEach(() => {
    manager = new InterruptManager();
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  // ORC-17: waitForApproval returns a promise, resolve completes it
  describe('ORC-17: waitForApproval and resolve', () => {
    it('should return a promise from waitForApproval', () => {
      const promise = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'rm -rf /' });
      expect(promise).toBeInstanceOf(Promise);
    });

    it('should mark run as having a pending interrupt', () => {
      manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      expect(manager.hasPending('run-1')).toBe(true);
    });

    it('should not have pending for unknown run', () => {
      expect(manager.hasPending('unknown')).toBe(false);
    });

    it('should resolve promise when approved', async () => {
      const promise = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });

      const resolved = await manager.resolve('run-1', 'approve');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result.action).toBe('approve');
    });

    it('should resolve promise when rejected', async () => {
      const promise = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'rm -rf /' });

      await manager.resolve('run-1', 'reject', 'Too dangerous');

      const result = await promise;
      expect(result.action).toBe('reject');
      expect(result.data).toBe('Too dangerous');
    });

    it('should return false when resolving non-existent interrupt', async () => {
      const resolved = await manager.resolve('no-run', 'approve');
      expect(resolved).toBe(false);
    });

    it('should clear pending after resolve', async () => {
      manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      expect(manager.hasPending('run-1')).toBe(true);

      await manager.resolve('run-1', 'approve');
      expect(manager.hasPending('run-1')).toBe(false);
    });

    it('should return pending interrupt info via getPending', () => {
      manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'write_file', { path: '/tmp/test.txt' });

      const pending = manager.getPending('run-1');
      expect(pending).toBeDefined();
      expect(pending!.toolCallId).toBe('tc-1');
      expect(pending!.toolName).toBe('write_file');
      expect(pending!.args).toEqual({ path: '/tmp/test.txt' });
      expect(pending!.createdAt).toBeTypeOf('number');
    });

    it('should return undefined from getPending for unknown run', () => {
      expect(manager.getPending('unknown')).toBeUndefined();
    });
  });

  // Superseding behavior
  describe('superseding interrupts', () => {
    it('should reject previous interrupt when a new one is created for the same run', async () => {
      const promise1 = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const promise2 = manager.waitForApproval('run-1', 'agent-1', 'tc-2', 'bash', { cmd: 'pwd' });

      // First promise should have been rejected with 'Superseded by new interrupt'
      const result1 = await promise1;
      expect(result1.action).toBe('reject');
      expect(result1.data).toBe('Superseded by new interrupt');

      // Second interrupt is the active one
      const pending = manager.getPending('run-1');
      expect(pending!.toolCallId).toBe('tc-2');

      // Resolve the second one
      await manager.resolve('run-1', 'approve');
      const result2 = await promise2;
      expect(result2.action).toBe('approve');
    });
  });

  // Shutdown behavior
  describe('shutdown', () => {
    it('should reject all pending interrupts on shutdown', async () => {
      const promise1 = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const promise2 = manager.waitForApproval('run-2', 'agent-2', 'tc-2', 'read', { path: '/' });

      manager.shutdown();

      const result1 = await promise1;
      const result2 = await promise2;

      expect(result1.action).toBe('reject');
      expect(result1.data).toBe('Server shutting down');
      expect(result2.action).toBe('reject');
      expect(result2.data).toBe('Server shutting down');
    });

    it('should have no pending interrupts after shutdown', () => {
      manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      manager.shutdown();
      expect(manager.hasPending('run-1')).toBe(false);
    });
  });

  // Multiple agents — now keyed by runId
  describe('multiple agents', () => {
    it('should handle concurrent interrupts for different runs independently', async () => {
      const p1 = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const p2 = manager.waitForApproval('run-2', 'agent-2', 'tc-2', 'read', { path: '/etc' });

      expect(manager.hasPending('run-1')).toBe(true);
      expect(manager.hasPending('run-2')).toBe(true);

      await manager.resolve('run-1', 'approve');
      const r1 = await p1;
      expect(r1.action).toBe('approve');

      // run-2 still pending
      expect(manager.hasPending('run-2')).toBe(true);

      await manager.resolve('run-2', 'reject', 'No access');
      const r2 = await p2;
      expect(r2.action).toBe('reject');
      expect(r2.data).toBe('No access');
    });
  });

  // Concurrent runs of the same agent (the core fix)
  describe('concurrent runs of same agent', () => {
    it('should allow two concurrent interrupts for the same agent with different runIds', async () => {
      const p1 = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const p2 = manager.waitForApproval('run-2', 'agent-1', 'tc-2', 'bash', { cmd: 'pwd' });

      // Both should be pending (keyed by runId, not agentId)
      expect(manager.hasPending('run-1')).toBe(true);
      expect(manager.hasPending('run-2')).toBe(true);

      // Resolve run-1; run-2 should be unaffected
      await manager.resolve('run-1', 'approve');
      const r1 = await p1;
      expect(r1.action).toBe('approve');

      // run-2 still pending
      expect(manager.hasPending('run-2')).toBe(true);

      // Resolve run-2
      await manager.resolve('run-2', 'reject', 'Denied');
      const r2 = await p2;
      expect(r2.action).toBe('reject');
      expect(r2.data).toBe('Denied');
    });

    it('resolving run-1 does not affect run-2 pending interrupt', async () => {
      const p1 = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'deploy', { target: 'prod' });
      const p2 = manager.waitForApproval('run-2', 'agent-1', 'tc-2', 'deploy', { target: 'staging' });

      // Resolve run-1
      await manager.resolve('run-1', 'approve');
      const r1 = await p1;
      expect(r1.action).toBe('approve');
      expect(manager.hasPending('run-1')).toBe(false);

      // run-2 is completely unaffected
      expect(manager.hasPending('run-2')).toBe(true);
      const pending2 = manager.getPending('run-2');
      expect(pending2).toBeDefined();
      expect(pending2!.toolCallId).toBe('tc-2');
      expect(pending2!.toolName).toBe('deploy');
      expect(pending2!.args).toEqual({ target: 'staging' });

      // Resolve run-2
      await manager.resolve('run-2', 'approve');
      const r2 = await p2;
      expect(r2.action).toBe('approve');
    });
  });

  // Event bus emissions
  describe('event bus emissions', () => {
    it('waitForApproval emits run.interrupted event', async () => {
      const bus = new TypedEventBus();
      const busManager = new InterruptManager(bus);
      const events: any[] = [];
      bus.on('run.interrupted', (payload) => {
        events.push(payload);
      });

      busManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 10));

       expect(events).toHaveLength(1);
       expect(events[0].turnId).toBe('run-1');
       expect(events[0].agentId).toBe('agent-1');
       expect(events[0].toolCallId).toBe('tc-1');
       expect(events[0].toolName).toBe('bash');
       expect(events[0].args).toEqual({ cmd: 'ls' });
       expect(events[0].timestamp).toBeTypeOf('number');

      busManager.shutdown();
    });

    it('resolve emits run.interrupt_resolved event', async () => {
      const bus = new TypedEventBus();
      const busManager = new InterruptManager(bus);
      const events: any[] = [];
      bus.on('run.interrupt_resolved', (payload) => {
        events.push(payload);
      });

      busManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      await busManager.resolve('run-1', 'approve', undefined, 'agent-1');

       expect(events).toHaveLength(1);
       expect(events[0].turnId).toBe('run-1');
       expect(events[0].agentId).toBe('agent-1');
       expect(events[0].action).toBe('approve');
       expect(events[0].timestamp).toBeTypeOf('number');

       busManager.shutdown();
     });

     it('timeout emits run.interrupt_resolved with action suspend', async () => {
       vi.useFakeTimers();
       const bus = new TypedEventBus();
       const busManager = new InterruptManager(bus);
       const events: any[] = [];
       bus.on('run.interrupt_resolved', (payload) => {
         events.push(payload);
       });

       busManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 1000);

       vi.advanceTimersByTime(1000);

       expect(events).toHaveLength(1);
       expect(events[0].turnId).toBe('run-1');
      expect(events[0].agentId).toBe('agent-1');
      expect(events[0].action).toBe('suspend');
      expect(events[0].timestamp).toBeTypeOf('number');

      busManager.shutdown();
      vi.useRealTimers();
    });
  });

  describe('loadFromDb', () => {
    it('does not expose a pending interrupt when the durable create write fails', async () => {
      const bus = new TypedEventBus();
      const events: Array<{ turnId: string }> = [];
      bus.on('run.interrupted', (payload) => {
        events.push({ turnId: payload.turnId });
      });

      const failingDb: InterruptStore = {
        savePendingInterrupt: vi.fn(async () => {
          throw new Error('DB down');
        }),
        resolveInterrupt: vi.fn(),
        cleanupExpiredInterrupts: vi.fn(async () => 0),
        getAllPendingInterrupts: vi.fn(async () => []),
      };

      const durableManager = new InterruptManager(bus, failingDb);

      await expect(
        durableManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 60_000),
      ).rejects.toThrow('DB down');

      expect(durableManager.hasPending('run-1')).toBe(false);
      expect(events).toEqual([]);

      durableManager.shutdown();
    });

    it('reloads non-expired pending interrupts so they can be resolved after restart', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));

      const { db } = createMockInterruptDb();
      const firstManager = new InterruptManager(undefined, db);
      firstManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 60_000, 'session-1');
      await Promise.resolve();
      await Promise.resolve();

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(db.cleanupExpiredInterrupts).toHaveBeenCalledWith(Date.now());
      expect(db.getAllPendingInterrupts).toHaveBeenCalledTimes(1);
      expect(restartedManager.hasPending('run-1')).toBe(true);
      expect(restartedManager.getPending('run-1')).toEqual({
        toolCallId: 'tc-1',
        toolName: 'bash',
        args: { cmd: 'ls' },
        createdAt: Date.now(),
        sessionId: 'session-1',
      });

      await expect(restartedManager.resolve('run-1', 'approve', 'approved', 'agent-1')).resolves.toBe(true);
      expect(restartedManager.hasPending('run-1')).toBe(false);
      expect(db.resolveInterrupt).toHaveBeenCalledWith('run-1', 'approve', 'approved');

      firstManager.shutdown();
      restartedManager.shutdown();
    });

    it('cleans up expired interrupts during restart instead of reloading them', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));

      const { db, rows } = createMockInterruptDb();
      const firstManager = new InterruptManager(undefined, db);
      firstManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 1_000);
      await Promise.resolve();
      await Promise.resolve();

      vi.setSystemTime(new Date('2026-03-25T12:00:02.000Z'));

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(db.cleanupExpiredInterrupts).toHaveBeenCalledWith(Date.now());
      expect(rows.has('run-1')).toBe(false);
      expect(restartedManager.hasPending('run-1')).toBe(false);
      await expect(restartedManager.resolve('run-1', 'approve')).resolves.toBe(false);

      firstManager.shutdown();
      restartedManager.shutdown();
    });
  });
});
