/**
 * Tests for POST /api/runs/:id/resume endpoint.
 *
 * Covers:
 * - Returns 404 for non-existent run
 * - Returns 400 when run is not suspended
 * - Successfully resumes a suspended run
 * - Validates various non-suspended statuses (running, paused, completed, error)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunRegistry } from '../../packages/ctxmill/src/orchestrator/run-registry.js';
import type { AgentRun } from '../../packages/ctxmill/src/orchestrator/run-registry.js';

describe('POST /api/runs/:id/resume', () => {
  let registry: RunRegistry;

  beforeEach(() => {
    registry = new RunRegistry();
  });

  describe('RunRegistry.resumeRun with suspended status', () => {
    it('resumes a suspended run back to running', async () => {
      // Start a run, then suspend it
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test task');
      const suspended = await registry.suspendRun(run.id, 'checkpoint_saved');

      expect(suspended).toBeDefined();
      expect(suspended!.status).toBe('suspended');

      // Now resume it
      const resumed = await registry.resumeRun(run.id);

      expect(resumed).toBeDefined();
      expect(resumed!.status).toBe('running');
      expect(resumed!.resumedAt).toBeTypeOf('number');
    });

    it('returns undefined when trying to resume a non-existent run', async () => {
      const result = await registry.resumeRun('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to resume a running run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const result = await registry.resumeRun(run.id);
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to resume a completed run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.completeRun(run.id);
      const result = await registry.resumeRun(run.id);
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to resume an errored run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.completeRun(run.id, 'some error');
      const result = await registry.resumeRun(run.id);
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to resume a cancelled run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.cancelRun(run.id);
      const result = await registry.resumeRun(run.id);
      expect(result).toBeUndefined();
    });
  });

  describe('RunRegistry.suspendRun', () => {
    it('suspends a running run and records reason + timestamp', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test task');
      expect(run.status).toBe('running');

      const suspended = await registry.suspendRun(run.id, 'checkpoint_saved');

      expect(suspended).toBeDefined();
      expect(suspended!.status).toBe('suspended');
      expect(suspended!.pausedAt).toBeTypeOf('number');
      expect(suspended!.pausedReason).toBe('checkpoint_saved');
    });

    it('returns undefined when trying to suspend a non-running run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.completeRun(run.id);

      const result = await registry.suspendRun(run.id, 'should_fail');
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to suspend a non-existent run', async () => {
      const result = await registry.suspendRun('non-existent', 'reason');
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to suspend an already suspended run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.suspendRun(run.id, 'first_suspend');

      const result = await registry.suspendRun(run.id, 'second_suspend');
      expect(result).toBeUndefined();
    });

    it('returns undefined when trying to suspend a paused run', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.pauseRun(run.id, 'hitl');

      const result = await registry.suspendRun(run.id, 'reason');
      expect(result).toBeUndefined();
    });
  });

  describe('Suspended status in run queries', () => {
    it('suspended runs count as active runs', async () => {
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const run2 = await registry.startRun('agent-1', 'conv-2', 'interactive');

      await registry.suspendRun(run1.id, 'checkpoint');

      const active = registry.getActiveRuns('agent-1');
      expect(active).toHaveLength(2);

      const statuses = active.map((r) => r.status).sort();
      expect(statuses).toEqual(['running', 'suspended']);
    });

    it('getRunsByStatus returns suspended runs', async () => {
      const run = await registry.startRun('agent-2', 'conv-1', 'interactive');
      await registry.suspendRun(run.id, 'checkpoint');

      const suspendedRuns = registry.getRunsByStatus('suspended');
      expect(suspendedRuns.length).toBeGreaterThanOrEqual(1);
      expect(suspendedRuns.some((r) => r.id === run.id)).toBe(true);
    });
  });

  describe('Full lifecycle: running -> suspended -> running -> completed', () => {
    it('completes the full suspend/resume cycle', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'suspend test');
      expect(run.status).toBe('running');

      // Suspend
      const suspended = await registry.suspendRun(run.id, 'checkpoint_saved');
      expect(suspended!.status).toBe('suspended');

      // Resume
      const resumed = await registry.resumeRun(run.id);
      expect(resumed!.status).toBe('running');

      // Complete
      const completed = await registry.completeRun(run.id);
      expect(completed!.status).toBe('completed');
    });

    it('supports running -> suspended -> cancelled', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      await registry.suspendRun(run.id, 'checkpoint');
      const cancelled = await registry.cancelRun(run.id);

      expect(cancelled!.status).toBe('cancelled');
    });
  });

  describe('DB persistence for suspend', () => {
    it('suspendRun persists to DB', async () => {
      const mockDb = {
        createRun: vi.fn().mockResolvedValue({}),
        updateRun: vi.fn().mockResolvedValue({}),
        getAllRuns: vi.fn().mockResolvedValue([]),
      };

      const dbRegistry = new RunRegistry(mockDb as any);
      const run = await dbRegistry.startRun('agent-1', 'conv-1', 'interactive');

      await dbRegistry.suspendRun(run.id, 'checkpoint_saved');

      expect(mockDb.updateRun).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({
          status: 'suspended',
          pausedReason: 'checkpoint_saved',
        }),
      );
    });
  });

  describe('Restart recovery with suspended status', () => {
    it('suspended runs survive restart (remain suspended)', async () => {
      const mockDb = {
        getAllRuns: vi.fn().mockResolvedValue([
          {
            id: 'run-suspended',
            agentId: 'agent-1',
            conversationId: 'conv-1',
            status: 'suspended',
            mode: 'interactive',
            startedAt: Date.now() - 10000,
            completedAt: null,
            error: null,
            taskDescription: 'suspended for checkpoint',
            sessionDir: null,
            pausedAt: Date.now() - 5000,
            pausedReason: 'checkpoint_saved',
          },
        ]),
        updateRun: vi.fn().mockResolvedValue({}),
        createRun: vi.fn().mockResolvedValue({}),
      };

      const freshRegistry = new RunRegistry();
      await freshRegistry.loadFromDb(mockDb as any);

      const run = freshRegistry.getRun('run-suspended');
      expect(run).toBeDefined();
      expect(run!.status).toBe('suspended');
      expect(run!.pausedReason).toBe('checkpoint_saved');

      // DB should NOT have been updated (suspended runs are preserved)
      expect(mockDb.updateRun).not.toHaveBeenCalled();
    });
  });
});
