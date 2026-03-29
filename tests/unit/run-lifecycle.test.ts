/**
 * Durable Run Lifecycle Tests
 *
 * Tests for the paused state, restart recovery, and state machine transitions:
 * - running -> paused -> running -> completed
 * - paused runs survive restart (loadFromDb preserves paused state)
 * - queued runs survive restart (loadFromDb preserves queued state)
 * - running runs are marked as error on restart
 * - pauseRun/resumeRun validation (wrong state returns undefined)
 * - getRunsByStatus and getActiveRunsForAgent
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunRegistry } from '../../packages/ctxmill/src/orchestrator/run-registry.js';
import {
  createTestBus,
  collectEvents,
} from '../utils/event-bus-test-helpers.js';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

describe('Durable Run Lifecycle', () => {
  let bus: TypedEventBus;
  let registry: RunRegistry;

  beforeEach(() => {
    bus = createTestBus();
    registry = new RunRegistry(undefined, bus);
  });

  // ── 1. Pause/Resume state transitions ────────────────────────

  describe('pauseRun()', () => {
    it('pauses a running run and records reason + timestamp', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test task');
      expect(run.status).toBe('running');

      const paused = await registry.pauseRun(run.id, 'hitl_approval');

      expect(paused).toBeDefined();
      expect(paused!.status).toBe('paused');
      expect(paused!.pausedAt).toBeTypeOf('number');
      expect(paused!.pausedReason).toBe('hitl_approval');
    });

    it('returns undefined when trying to pause a non-running run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.completeRun(run.id);

      const result = await registry.pauseRun(run.id, 'should_fail');
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to pause a non-existent run', async () => {
      const result = await registry.pauseRun('non-existent', 'reason');
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to pause an already paused run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.pauseRun(run.id, 'first_pause');

      const result = await registry.pauseRun(run.id, 'second_pause');
      expect(result).toBeUndefined();
    });
  });

  describe('resumeRun()', () => {
    it('resumes a paused run back to running', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test');
      await registry.pauseRun(run.id, 'hitl_approval');

      const resumed = await registry.resumeRun(run.id);

      expect(resumed).toBeDefined();
      expect(resumed!.status).toBe('running');
      expect(resumed!.resumedAt).toBeTypeOf('number');
    });

    it('returns undefined when trying to resume a non-paused run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      const result = await registry.resumeRun(run.id);
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to resume a non-existent run', async () => {
      const result = await registry.resumeRun('non-existent');
      expect(result).toBeUndefined();
    });

    it('creates a new AbortController on resume', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      // Original signal exists
      const signalBefore = registry.getAbortSignal(run.id);
      expect(signalBefore).toBeDefined();

      await registry.pauseRun(run.id, 'reason');
      await registry.resumeRun(run.id);

      // New signal exists after resume
      const signalAfter = registry.getAbortSignal(run.id);
      expect(signalAfter).toBeDefined();
      expect(signalAfter!.aborted).toBe(false);
    });
  });

  // ── 2. Full lifecycle: running -> paused -> running -> completed ──

  describe('Full state machine lifecycle', () => {
    it('running -> paused -> running -> completed', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'lifecycle test');
      expect(run.status).toBe('running');

      // Pause
      const paused = await registry.pauseRun(run.id, 'hitl_approval');
      expect(paused!.status).toBe('paused');

      // Resume
      const resumed = await registry.resumeRun(run.id);
      expect(resumed!.status).toBe('running');

      // Complete
      const completed = await registry.completeRun(run.id);
      expect(completed!.status).toBe('completed');
      expect(completed!.completedAt).toBeTypeOf('number');
    });

    it('running -> paused -> cancelled', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      await registry.pauseRun(run.id, 'external_suspension');
      const cancelled = await registry.cancelRun(run.id);

      expect(cancelled!.status).toBe('cancelled');
    });

    it('paused runs count as active runs (for concurrency limits)', async () => {
      await registry.startRun('agent-1', 'conv-1', 'interactive');
      const run2 = await registry.startRun('agent-1', 'conv-2', 'interactive');
      await registry.startRun('agent-1', 'conv-3', 'interactive');

      expect(registry.getActiveRuns('agent-1')).toHaveLength(3);

      // Pause one — still counts as active
      await registry.pauseRun(run2.id, 'hitl');
      expect(registry.getActiveRuns('agent-1')).toHaveLength(3);

      // Cannot start a 4th
      await expect(
        registry.startRun('agent-1', 'conv-4', 'interactive'),
      ).rejects.toThrow(/Concurrent run limit/);
    });
  });

  // ── 3. Restart recovery (loadFromDb) ─────────────────────────

  describe('Restart recovery via loadFromDb()', () => {
    it('running runs are marked as error on restart', async () => {
      // Simulate DB with a running run
      const mockDb = createMockDbWithRuns([
        {
          id: 'run-1',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          status: 'running',
          mode: 'interactive',
          startedAt: Date.now() - 5000,
          completedAt: null,
          error: null,
          taskDescription: 'interrupted task',
        },
      ]);

      const freshRegistry = new RunRegistry(undefined, bus);
      await freshRegistry.loadFromDb(mockDb as any);

      const run = freshRegistry.getRun('run-1');
      expect(run).toBeDefined();
      expect(run!.status).toBe('error');
      expect(run!.error).toBe('Server restarted during execution');
      expect(run!.completedAt).toBeTypeOf('number');

      // Verify DB was updated
      expect(mockDb.updateRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
        status: 'error',
        error: 'Server restarted during execution',
      }));
    });

    it('paused runs survive restart (remain paused)', async () => {
      const mockDb = createMockDbWithRuns([
        {
          id: 'run-paused',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          status: 'paused',
          mode: 'interactive',
          startedAt: Date.now() - 10000,
          completedAt: null,
          error: null,
          taskDescription: 'paused for HITL',
          pausedAt: Date.now() - 5000,
          pausedReason: 'hitl_approval',
        },
      ]);

      const freshRegistry = new RunRegistry(undefined, bus);
      await freshRegistry.loadFromDb(mockDb as any);

      const run = freshRegistry.getRun('run-paused');
      expect(run).toBeDefined();
      expect(run!.status).toBe('paused');
      expect(run!.pausedReason).toBe('hitl_approval');

      // DB should NOT have been updated (paused runs are preserved)
      expect(mockDb.updateRun).not.toHaveBeenCalled();
    });

    it('queued runs survive restart (remain queued)', async () => {
      const mockDb = createMockDbWithRuns([
        {
          id: 'run-queued',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          status: 'queued',
          mode: 'background',
          startedAt: Date.now() - 1000,
          completedAt: null,
          error: null,
          taskDescription: 'waiting to run',
        },
      ]);

      const freshRegistry = new RunRegistry(undefined, bus);
      await freshRegistry.loadFromDb(mockDb as any);

      const run = freshRegistry.getRun('run-queued');
      expect(run).toBeDefined();
      expect(run!.status).toBe('queued');

      // DB should NOT have been updated (queued runs are preserved)
      expect(mockDb.updateRun).not.toHaveBeenCalled();
    });

    it('mixed states: running errored, paused preserved, queued preserved, completed untouched', async () => {
      const now = Date.now();
      const mockDb = createMockDbWithRuns([
        {
          id: 'run-running',
          agentId: 'agent-1',
          conversationId: 'conv-1',
          status: 'running',
          mode: 'interactive',
          startedAt: now - 5000,
          completedAt: null,
          error: null,
          taskDescription: null,
        },
        {
          id: 'run-paused',
          agentId: 'agent-1',
          conversationId: 'conv-2',
          status: 'paused',
          mode: 'interactive',
          startedAt: now - 10000,
          completedAt: null,
          error: null,
          taskDescription: null,
          pausedAt: now - 3000,
          pausedReason: 'external_suspension',
        },
        {
          id: 'run-queued',
          agentId: 'agent-1',
          conversationId: 'conv-3',
          status: 'queued',
          mode: 'background',
          startedAt: now - 1000,
          completedAt: null,
          error: null,
          taskDescription: null,
        },
        {
          id: 'run-completed',
          agentId: 'agent-1',
          conversationId: 'conv-4',
          status: 'completed',
          mode: 'interactive',
          startedAt: now - 20000,
          completedAt: now - 15000,
          error: null,
          taskDescription: null,
        },
      ]);

      const freshRegistry = new RunRegistry(undefined, bus);
      await freshRegistry.loadFromDb(mockDb as any);

      // Running -> error
      expect(freshRegistry.getRun('run-running')!.status).toBe('error');

      // Paused -> still paused
      expect(freshRegistry.getRun('run-paused')!.status).toBe('paused');

      // Queued -> still queued
      expect(freshRegistry.getRun('run-queued')!.status).toBe('queued');

      // Completed -> still completed
      expect(freshRegistry.getRun('run-completed')!.status).toBe('completed');

      // Only the running run should have been updated in DB
      expect(mockDb.updateRun).toHaveBeenCalledTimes(1);
      expect(mockDb.updateRun).toHaveBeenCalledWith('run-running', expect.objectContaining({
        status: 'error',
      }));
    });
  });

  // ── 4. getRunsByStatus ──────────────────────────────────────

  describe('getRunsByStatus()', () => {
    it('returns runs filtered by status', async () => {
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const run2 = await registry.startRun('agent-1', 'conv-2', 'interactive');
      await registry.pauseRun(run1.id, 'hitl');
      await registry.completeRun(run2.id);

      const pausedRuns = registry.getRunsByStatus('paused');
      expect(pausedRuns).toHaveLength(1);
      expect(pausedRuns[0].id).toBe(run1.id);

      const completedRuns = registry.getRunsByStatus('completed');
      expect(completedRuns).toHaveLength(1);
      expect(completedRuns[0].id).toBe(run2.id);

      const runningRuns = registry.getRunsByStatus('running');
      expect(runningRuns).toHaveLength(0);
    });

    it('filters by agentId when provided', async () => {
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const run2 = await registry.startRun('agent-2', 'conv-2', 'interactive');

      const agent1Runs = registry.getRunsByStatus('running', 'agent-1');
      expect(agent1Runs).toHaveLength(1);
      expect(agent1Runs[0].id).toBe(run1.id);

      const agent2Runs = registry.getRunsByStatus('running', 'agent-2');
      expect(agent2Runs).toHaveLength(1);
      expect(agent2Runs[0].id).toBe(run2.id);
    });
  });

  // ── 5. getActiveRunsForAgent ─────────────────────────────────

  describe('getActiveRunsForAgent()', () => {
    it('returns active runs (queued, running, paused) for agent', async () => {
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const run2 = await registry.startRun('agent-1', 'conv-2', 'interactive');
      const run3 = await registry.startRun('agent-1', 'conv-3', 'interactive');

      // Pause one, complete another
      await registry.pauseRun(run1.id, 'hitl');
      await registry.completeRun(run2.id);

      const active = registry.getActiveRunsForAgent('agent-1');
      expect(active).toHaveLength(2); // paused + running (run3)

      const statuses = active.map(r => r.status).sort();
      expect(statuses).toEqual(['paused', 'running']);
    });

    it('returns empty array for unknown agent', () => {
      const active = registry.getActiveRunsForAgent('unknown-agent');
      expect(active).toHaveLength(0);
    });
  });

  // ── 6. Event emission ────────────────────────────────────────

  describe('Event emission for pause/resume', () => {
    it('pauseRun emits a run.paused event', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const collector = collectEvents(bus, 'run.paused');

      await registry.pauseRun(run.id, 'hitl_approval');

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          runId: run.id,
          agentId: 'agent-1',
          reason: 'hitl_approval',
        }),
      );

      collector.unsubscribe();
    });

    it('resumeRun emits a run.started event', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      await registry.pauseRun(run.id, 'hitl_approval');

      const collector = collectEvents(bus, 'run.started');
      await registry.resumeRun(run.id);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          runId: run.id,
          agentId: 'agent-1',
        }),
      );

      collector.unsubscribe();
    });
  });

  // ── 7. DB persistence for pause/resume ───────────────────────

  describe('DB persistence for pause/resume', () => {
    it('pauseRun persists to DB', async () => {
      const mockDb = {
        createRun: vi.fn().mockResolvedValue({}),
        updateRun: vi.fn().mockResolvedValue({}),
        getAllRuns: vi.fn().mockResolvedValue([]),
      };

      const dbRegistry = new RunRegistry(mockDb as any, bus);
      const run = await dbRegistry.startRun('agent-1', 'conv-1', 'interactive');

      await dbRegistry.pauseRun(run.id, 'hitl_approval');

      expect(mockDb.updateRun).toHaveBeenCalledWith(run.id, expect.objectContaining({
        status: 'paused',
        pausedReason: 'hitl_approval',
      }));
    });

    it('resumeRun persists to DB', async () => {
      const mockDb = {
        createRun: vi.fn().mockResolvedValue({}),
        updateRun: vi.fn().mockResolvedValue({}),
        getAllRuns: vi.fn().mockResolvedValue([]),
      };

      const dbRegistry = new RunRegistry(mockDb as any, bus);
      const run = await dbRegistry.startRun('agent-1', 'conv-1', 'interactive');

      await dbRegistry.pauseRun(run.id, 'hitl_approval');
      await dbRegistry.resumeRun(run.id);

      // Last call should be the resume update
      const lastCall = mockDb.updateRun.mock.calls[mockDb.updateRun.mock.calls.length - 1];
      expect(lastCall[0]).toBe(run.id);
      expect(lastCall[1]).toEqual(expect.objectContaining({
        status: 'running',
      }));
      expect(lastCall[1].resumedAt).toBeTypeOf('number');
    });
  });

  // ── 8. AgentRun interface new fields ─────────────────────────

  describe('AgentRun new fields', () => {
    it('new fields default to undefined on fresh runs', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      expect(run.pausedAt).toBeUndefined();
      expect(run.pausedReason).toBeUndefined();
      expect(run.resumedAt).toBeUndefined();
    });
  });
});

// ── Helper ──────────────────────────────────────────────────────

function createMockDbWithRuns(runs: any[]) {
  return {
    getAllRuns: vi.fn().mockResolvedValue(runs),
    updateRun: vi.fn().mockResolvedValue({}),
    createRun: vi.fn().mockResolvedValue({}),
  };
}
