import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';
import type {
  ExpectedSandboxCallbackDelivery,
  InterruptRow,
} from '../../packages/ctxmill/src/database/repository.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

type InterruptStore = NonNullable<ConstructorParameters<typeof InterruptManager>[1]>;
type InterruptInsert = Parameters<InterruptStore['savePendingInterrupt']>[0];

function createMockInterruptDb(options: {
  beforeSave?: (data: InterruptInsert) => Promise<void>;
  exactInstallResult?: 'admit' | 'stale';
} = {}) {
  const rows = new Map<string, InterruptRow>();

  const toRow = (data: InterruptInsert): InterruptRow => ({
    id: data.id,
    turnId: data.turnId,
    agentId: data.agentId,
    sandboxSessionId: data.sandboxSessionId ?? null,
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
      if (options.beforeSave) {
        await options.beforeSave(data);
      }
      const row = toRow(data);
      rows.set(row.id, row);
      return row;
    }),
    installPendingInterruptIfSandboxCallbackCurrent: vi.fn(async (
      data: InterruptInsert,
      _authority: ExpectedSandboxCallbackDelivery,
      supersededInterruptId?: string,
    ) => {
      if (options.exactInstallResult === 'stale') {
        return undefined;
      }
      if (supersededInterruptId) {
        const superseded = rows.get(supersededInterruptId);
        if (!superseded || superseded.status !== 'pending') {
          return undefined;
        }
        rows.set(supersededInterruptId, {
          ...superseded,
          status: 'resolved',
          resolvedAt: Date.now(),
          resolvedAction: 'reject',
          resolvedData: 'Superseded by new interrupt',
        });
      }
      const row = toRow(data);
      rows.set(row.id, row);
      return row;
    }),
    deletePendingInterruptInstallation: vi.fn(async (
      id: string,
      turnId: string,
      toolCallId: string,
    ) => {
      const row = rows.get(id);
      if (
        !row
        || row.turnId !== turnId
        || row.toolCallId !== toolCallId
        || row.status !== 'pending'
      ) {
        return false;
      }
      rows.delete(id);
      return true;
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

const SANDBOX_CALLBACK_AUTHORITY: ExpectedSandboxCallbackDelivery = {
  turnId: 'run-1',
  sandboxSessionId: 'sandbox-1',
  agentId: 'agent-1',
  expectedDeliveryFence: {
    ownerId: 'worker-a',
    fenceToken: 7,
  },
  expectedActiveGeneration: {
    restoreFenceToken: 3,
    containerId: 'container-a',
  },
};

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
      expect(manager.hasPendingForTurn('run-1')).toBe(true);
    });

    it('should not have pending for unknown run', () => {
      expect(manager.hasPendingForTurn('unknown')).toBe(false);
    });

    it('should resolve promise when approved', async () => {
      const promise = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });

      const resolved = await manager.resolveForTurn('run-1', 'approve');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result.action).toBe('approve');
    });

    it('should resolve promise when rejected', async () => {
      const promise = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'rm -rf /' });

      await manager.resolveForTurn('run-1', 'reject', 'Too dangerous');

      const result = await promise;
      expect(result.action).toBe('reject');
      expect(result.data).toBe('Too dangerous');
    });

    it('should return false when resolving non-existent interrupt', async () => {
      const resolved = await manager.resolveForTurn('no-run', 'approve');
      expect(resolved).toBe(false);
    });

    it('should clear pending after resolve', async () => {
      manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      expect(manager.hasPendingForTurn('run-1')).toBe(true);

      await manager.resolveForTurn('run-1', 'approve');
      expect(manager.hasPendingForTurn('run-1')).toBe(false);
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
      expect(manager.hasPendingForTurn('run-1')).toBe(true);

      // Resolve the second one
      await manager.resolveForTurn('run-1', 'approve');
      const result2 = await promise2;
      expect(result2.action).toBe('approve');
    });

    it('keeps the replacement timeout armed after settling the superseded interrupt', async () => {
      vi.useFakeTimers();
      const previous = manager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'bash',
        { cmd: 'ls' },
        60_000,
      );
      const replacement = manager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-2',
        'bash',
        { cmd: 'pwd' },
        100,
      );

      await expect(previous).resolves.toMatchObject({
        action: 'reject',
        data: 'Superseded by new interrupt',
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(replacement).resolves.toMatchObject({ action: 'suspend' });
      expect(manager.hasPendingForTurn('run-1')).toBe(false);
    });

    it('settles the old waiter when durable resolution succeeds but its event cannot persist', async () => {
      const { db, rows } = createMockInterruptDb();
      const bus = new TypedEventBus({
        persistEvent: vi.fn(async (type) => {
          if (type === 'interrupt.resolved') {
            throw new Error('resolved event persistence failed');
          }
        }),
      });
      const durableManager = new InterruptManager(bus, db);
      const previous = durableManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'bash',
        { cmd: 'ls' },
      );
      await vi.waitFor(() => {
        expect(durableManager.hasPendingForTurn('run-1')).toBe(true);
      });

      const replacement = durableManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-2',
        'bash',
        { cmd: 'pwd' },
      );

      await expect(replacement).rejects.toThrow('resolved event persistence failed');
      expect(durableManager.hasPendingForTurn('run-1')).toBe(false);
      await expect(previous).resolves.toEqual({
        action: 'reject',
        data: 'Superseded by new interrupt',
      });
      expect(Array.from(rows.values()).map((row) => row.status)).toEqual(['resolved']);

      durableManager.shutdown();
    });

    it('keeps the old timeout armed when supersession cannot persist its resolution event', async () => {
      vi.useFakeTimers();
      let resolutionAttempts = 0;
      const bus = new TypedEventBus({
        persistEvent: vi.fn(async (type) => {
          if (type === 'interrupt.resolved' && resolutionAttempts++ === 0) {
            throw new Error('transient resolved event failure');
          }
        }),
      });
      const busManager = new InterruptManager(bus);
      const previous = busManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'bash',
        { cmd: 'ls' },
        100,
      );
      const replacement = busManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-2',
        'bash',
        { cmd: 'pwd' },
      );

      await expect(replacement).rejects.toThrow('transient resolved event failure');
      expect(busManager.hasPendingForTurn('run-1')).toBe(true);
      await vi.advanceTimersByTimeAsync(100);

      await expect(previous).resolves.toMatchObject({ action: 'suspend' });
      expect(busManager.hasPendingForTurn('run-1')).toBe(false);

      busManager.shutdown();
    });

    it('serializes concurrent durable waiter installation for the same turn', async () => {
      let releaseFirstSave!: () => void;
      const firstSaveGate = new Promise<void>((resolve) => {
        releaseFirstSave = resolve;
      });
      let firstSaveEntered!: () => void;
      const enteredFirstSave = new Promise<void>((resolve) => {
        firstSaveEntered = resolve;
      });
      let saveCalls = 0;
      const { db } = createMockInterruptDb({
        beforeSave: async () => {
          saveCalls += 1;
          if (saveCalls === 1) {
            firstSaveEntered();
            await firstSaveGate;
          }
        },
      });
      const durableManager = new InterruptManager(undefined, db);

      const previous = durableManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'bash',
        { cmd: 'ls' },
      );
      await enteredFirstSave;
      const replacement = durableManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-2',
        'bash',
        { cmd: 'pwd' },
      );

      expect(saveCalls).toBe(1);
      releaseFirstSave();
      await expect(previous).resolves.toEqual({
        action: 'reject',
        data: 'Superseded by new interrupt',
      });
      expect(durableManager.hasPendingForTurn('run-1')).toBe(true);

      await expect(durableManager.resolveForTurn('run-1', 'approve')).resolves.toBe(true);
      await expect(replacement).resolves.toEqual({ action: 'approve' });

      durableManager.shutdown();
    });
  });

  describe('sandbox callback fencing', () => {
    it('rejects a stale approval installation without a row, event, or waiter', async () => {
      const { db, rows } = createMockInterruptDb({
        exactInstallResult: 'stale',
      });
      const persistEvent = vi.fn().mockResolvedValue(true);
      const bus = new TypedEventBus({ persistEvent });
      const listener = vi.fn();
      bus.on('interrupt.requested', listener);
      const durableManager = new InterruptManager(bus, db);

      await expect(durableManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'request-approval',
        { reason: 'confirm' },
        60_000,
        'sandbox-1',
        'conversation-1',
        SANDBOX_CALLBACK_AUTHORITY,
      )).rejects.toThrow(
        'Sandbox callback delivery ownership changed before interrupt persistence',
      );

      expect(db.installPendingInterruptIfSandboxCallbackCurrent).toHaveBeenCalledOnce();
      expect(db.savePendingInterrupt).not.toHaveBeenCalled();
      expect(rows.size).toBe(0);
      expect(persistEvent).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(durableManager.hasPendingForTurn('run-1')).toBe(false);

      durableManager.shutdown();
    });

    it('passes exact authority to event persistence and compensates a rejected event', async () => {
      const { db, rows } = createMockInterruptDb();
      const persistEvent = vi.fn().mockResolvedValue(false);
      const bus = new TypedEventBus({ persistEvent });
      const listener = vi.fn();
      bus.on('interrupt.requested', listener);
      const durableManager = new InterruptManager(bus, db);

      await expect(durableManager.waitForApproval(
        'run-1',
        'agent-1',
        'tc-1',
        'request-approval',
        { reason: 'confirm' },
        60_000,
        'sandbox-1',
        'conversation-1',
        SANDBOX_CALLBACK_AUTHORITY,
      )).rejects.toThrow(
        'Interrupt request event was rejected for stale turn delivery',
      );

      expect(persistEvent).toHaveBeenCalledWith(
        'interrupt.requested',
        'agent-1',
        expect.any(String),
        expect.objectContaining({
          turnId: 'run-1',
          sandboxSessionId: 'sandbox-1',
        }),
        {
          deliveryFence: SANDBOX_CALLBACK_AUTHORITY.expectedDeliveryFence,
          sandboxSessionId: 'sandbox-1',
          activeGeneration: SANDBOX_CALLBACK_AUTHORITY.expectedActiveGeneration,
        },
      );
      expect(db.deletePendingInterruptInstallation).toHaveBeenCalledOnce();
      expect(rows.size).toBe(0);
      expect(listener).not.toHaveBeenCalled();
      expect(durableManager.hasPendingForTurn('run-1')).toBe(false);

      durableManager.shutdown();
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
      expect(manager.hasPendingForTurn('run-1')).toBe(false);
    });
  });

  // Multiple agents — now keyed by runId
  describe('multiple agents', () => {
    it('should handle concurrent interrupts for different runs independently', async () => {
      const p1 = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const p2 = manager.waitForApproval('run-2', 'agent-2', 'tc-2', 'read', { path: '/etc' });

      expect(manager.hasPendingForTurn('run-1')).toBe(true);
      expect(manager.hasPendingForTurn('run-2')).toBe(true);

      await manager.resolveForTurn('run-1', 'approve');
      const r1 = await p1;
      expect(r1.action).toBe('approve');

      // run-2 still pending
      expect(manager.hasPendingForTurn('run-2')).toBe(true);

      await manager.resolveForTurn('run-2', 'reject', 'No access');
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
      expect(manager.hasPendingForTurn('run-1')).toBe(true);
      expect(manager.hasPendingForTurn('run-2')).toBe(true);

      // Resolve run-1; run-2 should be unaffected
      await manager.resolveForTurn('run-1', 'approve');
      const r1 = await p1;
      expect(r1.action).toBe('approve');

      // run-2 still pending
      expect(manager.hasPendingForTurn('run-2')).toBe(true);

      // Resolve run-2
      await manager.resolveForTurn('run-2', 'reject', 'Denied');
      const r2 = await p2;
      expect(r2.action).toBe('reject');
      expect(r2.data).toBe('Denied');
    });

    it('resolving run-1 does not affect run-2 pending interrupt', async () => {
      const p1 = manager.waitForApproval('run-1', 'agent-1', 'tc-1', 'deploy', { target: 'prod' });
      const p2 = manager.waitForApproval('run-2', 'agent-1', 'tc-2', 'deploy', { target: 'staging' });

      // Resolve run-1
      await manager.resolveForTurn('run-1', 'approve');
      const r1 = await p1;
      expect(r1.action).toBe('approve');
      expect(manager.hasPendingForTurn('run-1')).toBe(false);

      // run-2 is completely unaffected
      expect(manager.hasPendingForTurn('run-2')).toBe(true);
      expect(manager.hasPendingForTurn('run-2')).toBe(true);

      // Resolve run-2
      await manager.resolveForTurn('run-2', 'approve');
      const r2 = await p2;
      expect(r2.action).toBe('approve');
    });
  });

  // Event bus emissions
  describe('event bus emissions', () => {
    it('persists a distinct interruptId with explicit turn and sandbox identities', async () => {
      const { db } = createMockInterruptDb();
      const bus = new TypedEventBus();
      const durableManager = new InterruptManager(bus, db);
      const interrupted: Array<{ turnId: string; interruptId: string }> = [];
      bus.on('interrupt.requested', (payload) => {
        interrupted.push({ turnId: payload.turnId, interruptId: payload.interruptId });
      });

      void durableManager.waitForApproval(
        'turn-1',
        'agent-1',
        'tc-1',
        'bash',
        { cmd: 'ls' },
        60_000,
        'sandbox-1',
      );
      await Promise.resolve();

      expect(db.savePendingInterrupt).toHaveBeenCalledWith(expect.objectContaining({
        turnId: 'turn-1',
        sandboxSessionId: 'sandbox-1',
      }));
      const saved = vi.mocked(db.savePendingInterrupt).mock.calls[0]?.[0] as unknown as {
        id: string;
      };
      expect(saved.id).not.toBe('turn-1');
      expect(interrupted).toEqual([{ turnId: 'turn-1', interruptId: saved.id }]);

      durableManager.shutdown();
    });

    it('waitForApproval emits interrupt.requested event', async () => {
      const bus = new TypedEventBus();
      const busManager = new InterruptManager(bus);
      const events: any[] = [];
      bus.on('interrupt.requested', (payload) => {
        events.push(payload);
      });

      busManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 10));

       expect(events).toHaveLength(1);
       expect(events[0].turnId).toBe('run-1');
       expect(events[0].agentId).toBe('agent-1');
       expect(events[0].toolCallId).toBe('tc-1');
       expect(events[0].toolCallName).toBe('bash');
       expect(events[0].args).toEqual({ cmd: 'ls' });
       expect(events[0].timestamp).toBeTypeOf('number');

      busManager.shutdown();
    });

    it('resolve emits interrupt.resolved event', async () => {
      const bus = new TypedEventBus();
      const busManager = new InterruptManager(bus);
      const events: any[] = [];
      bus.on('interrupt.resolved', (payload) => {
        events.push(payload);
      });

      busManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      await busManager.resolveForTurn('run-1', 'approve', undefined, 'agent-1');

       expect(events).toHaveLength(1);
       expect(events[0].turnId).toBe('run-1');
       expect(events[0].agentId).toBe('agent-1');
       expect(events[0].action).toBe('approve');
       expect(events[0].timestamp).toBeTypeOf('number');

       busManager.shutdown();
     });

     it('timeout emits interrupt.resolved with action timeout', async () => {
       vi.useFakeTimers();
       const bus = new TypedEventBus();
       const busManager = new InterruptManager(bus);
       const events: any[] = [];
       bus.on('interrupt.resolved', (payload) => {
         events.push(payload);
       });

       busManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 1000);

       vi.advanceTimersByTime(1000);

       expect(events).toHaveLength(1);
       expect(events[0].turnId).toBe('run-1');
      expect(events[0].agentId).toBe('agent-1');
      expect(events[0].action).toBe('timeout');
      expect(events[0].timestamp).toBeTypeOf('number');

      busManager.shutdown();
      vi.useRealTimers();
    });
  });

  describe('loadFromDb', () => {
    it('does not expose a pending interrupt when the durable create write fails', async () => {
      const bus = new TypedEventBus();
      const events: Array<{ turnId: string }> = [];
      bus.on('interrupt.requested', (payload) => {
        events.push({ turnId: payload.turnId });
      });

      const failingDb: InterruptStore = {
        savePendingInterrupt: vi.fn(async () => {
          throw new Error('DB down');
        }),
        resolveInterrupt: vi.fn(),
        markInterruptTimedOut: vi.fn(),
        cleanupExpiredInterrupts: vi.fn(async () => 0),
        getAllPendingInterrupts: vi.fn(async () => []),
      };

      const durableManager = new InterruptManager(bus, failingDb);

      await expect(
        durableManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 60_000),
      ).rejects.toThrow('DB down');

      expect(durableManager.hasPendingForTurn('run-1')).toBe(false);
      expect(events).toEqual([]);

      durableManager.shutdown();
    });

    it('reloads non-expired pending interrupts so they can be resolved after restart', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));

      const { db } = createMockInterruptDb();
      const firstManager = new InterruptManager(undefined, db);
      firstManager.waitForApproval('run-1', 'agent-1', 'tc-1', 'bash', { cmd: 'ls' }, 60_000, 'sandbox-1');
      await Promise.resolve();
      await Promise.resolve();
      const interruptId = firstManager.getPendingForAgent('agent-1')[0]?.info.interruptId;
      expect(interruptId).toBeTypeOf('string');

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(db.cleanupExpiredInterrupts).toHaveBeenCalledWith(Date.now());
      expect(db.getAllPendingInterrupts).toHaveBeenCalledTimes(1);
      expect(restartedManager.hasPendingForTurn('run-1')).toBe(true);

      await expect(restartedManager.resolveForTurn('run-1', 'approve', 'approved', 'agent-1')).resolves.toBe(true);
      expect(restartedManager.hasPendingForTurn('run-1')).toBe(false);
      expect(db.resolveInterrupt).toHaveBeenCalledWith(interruptId, 'approve', 'approved');

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
      const interruptId = firstManager.getPendingForAgent('agent-1')[0]?.info.interruptId;
      expect(interruptId).toBeTypeOf('string');

      vi.setSystemTime(new Date('2026-03-25T12:00:02.000Z'));

      const restartedManager = new InterruptManager(undefined, db);
      await restartedManager.loadFromDb();

      expect(db.cleanupExpiredInterrupts).toHaveBeenCalledWith(Date.now());
      expect(rows.has(interruptId!)).toBe(false);
      expect(restartedManager.hasPendingForTurn('run-1')).toBe(false);
      await expect(restartedManager.resolveForTurn('run-1', 'approve')).resolves.toBe(false);

      firstManager.shutdown();
      restartedManager.shutdown();
    });
  });
});
