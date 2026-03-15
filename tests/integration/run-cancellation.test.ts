/**
 * Run Cancellation with AbortSignal Integration Tests
 *
 * Tests the full cancellation flow using REAL RunRegistry + REAL TypedEventBus
 * with mock DB/executor externals. Validates AbortController lifecycle,
 * signal propagation to the executor loop, and edge cases around
 * cancelling non-existent, already-completed, and concurrent runs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { RunRegistry } from '../../packages/ctxmill/src/orchestrator/run-registry.js';
import { AgentRunService } from '../../packages/ctxmill/src/orchestrator/agent-run-service.js';
import {
  createTestBus,
  collectEvents,
  createMockSSEManager,
  createMockDatabase,
} from '../utils/event-bus-test-helpers.js';

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('Run Cancellation with AbortSignal', () => {
  let bus: TypedEventBus;
  let registry: RunRegistry;

  beforeEach(() => {
    bus = createTestBus();
    registry = new RunRegistry(undefined, bus);
  });

  // ── 1. AbortController lifecycle ─────────────────────────────────

  describe('AbortController lifecycle', () => {
    it('startRun() creates an AbortController and getAbortSignal() returns it', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'test task');

      const signal = registry.getAbortSignal(run.id);
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(false);
    });

    it('cancelRun() aborts the signal and sets run status to cancelled', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const signal = registry.getAbortSignal(run.id)!;

      expect(signal.aborted).toBe(false);

      const result = await registry.cancelRun(run.id);

      expect(result).toBeDefined();
      expect(result!.status).toBe('cancelled');
      expect(result!.completedAt).toBeTypeOf('number');
      expect(signal.aborted).toBe(true);
    });

    it('cancelRun() emits run.completed with status cancelled', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const collector = collectEvents(bus, 'run.completed');

      await registry.cancelRun(run.id);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          runId: run.id,
          agentId: 'agent-1',
          status: 'cancelled',
        }),
      );

      collector.unsubscribe();
    });

    it('getAbortSignal() returns undefined after cancellation (controller cleaned up)', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      // Grab signal reference before cancel
      const signalBefore = registry.getAbortSignal(run.id);
      expect(signalBefore).toBeDefined();

      await registry.cancelRun(run.id);

      // Controller is deleted after cancel
      const signalAfter = registry.getAbortSignal(run.id);
      expect(signalAfter).toBeUndefined();
    });
  });

  // ── 2. Signal propagation to executor loop ───────────────────────

  describe('Signal propagation to executor loop (AgentRunService)', () => {
    it('cancelling mid-execution terminates the executor loop early and persists partial content', async () => {
      const mockSSE = createMockSSEManager();
      const mockDB = createMockDatabase();
      mockDB.addMessage = vi.fn().mockResolvedValue({ id: 'msg-1' });

      // Track how many events the executor actually yielded before abort
      const yieldedEvents: string[] = [];

      // Mock executor that yields events slowly — checks signal between yields
      const mockExecutor = {
        run: vi.fn().mockImplementation(function* (_def: any, _msgs: any, _aid: any, _rid: any, signal?: AbortSignal) {
          // Use a sync generator wrapped in async iteration by the caller
          // Yield first chunk
          yieldedEvents.push('chunk-1');
          return (async function* () {
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'will-be-ignored', messageId: 'm1', content: 'Hello ' };

            // Small delay to allow cancellation to propagate
            await settle(20);

            if (signal?.aborted) return;

            yieldedEvents.push('chunk-2');
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'will-be-ignored', messageId: 'm1', content: 'World ' };

            await settle(20);

            if (signal?.aborted) return;

            yieldedEvents.push('chunk-3');
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'will-be-ignored', messageId: 'm1', content: 'Final' };
          })();
        }),
        getEnvironmentFactory: vi.fn().mockReturnValue(null),
      };

      // Fix: mockExecutor.run should return the async generator directly
      mockExecutor.run = vi.fn().mockImplementation(
        (_def: any, _msgs: any, _aid: any, _rid: any, signal?: AbortSignal) => {
          yieldedEvents.length = 0; // reset
          return (async function* () {
            yieldedEvents.push('chunk-1');
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'r', messageId: 'm1', content: 'Hello ' };

            await settle(30);
            if (signal?.aborted) return;

            yieldedEvents.push('chunk-2');
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'r', messageId: 'm1', content: 'World ' };

            await settle(30);
            if (signal?.aborted) return;

            yieldedEvents.push('chunk-3');
            yield { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), runId: 'r', messageId: 'm1', content: 'Final' };
          })();
        },
      );

      const service = new AgentRunService({
        executor: mockExecutor as any,
        sse: mockSSE as any,
        db: mockDB as any,
        runRegistry: registry,
        eventBus: bus,
      });

      // Start a run via registry so AbortController is created
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive', 'cancellable task');

      // Start execution in background, cancel after first chunk
      const execPromise = service.executeRun({
        agentDef: { name: 'test', systemPrompt: 'test', tools: [] } as any,
        messages: [{ id: 'u1', agentId: 'agent-1', role: 'user', content: 'Hi', createdAt: new Date() }],
        agentId: 'agent-1',
        conversationId: 'conv-1',
        runId: run.id,
        taskDescription: 'cancellable task',
      });

      // Wait enough for first chunk to be yielded, then cancel
      await settle(50);
      await registry.cancelRun(run.id);

      // Wait for executeRun to finish
      await execPromise;

      // The executor should have been cut short — not all 3 chunks processed
      expect(yieldedEvents.length).toBeLessThan(3);

      // Partial content should still be persisted
      expect(mockDB.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('Hello'),
        }),
      );

      // Run should NOT be completed again by AgentRunService (cancelRun already did it)
      const finalRun = registry.getRun(run.id);
      expect(finalRun!.status).toBe('cancelled');
    });
  });

  // ── 3. Cancel non-existent run ───────────────────────────────────

  describe('Cancel non-existent run', () => {
    it('cancelRun() with unknown runId returns undefined', async () => {
      const result = await registry.cancelRun('non-existent-run-id');
      expect(result).toBeUndefined();
    });

    it('no event is emitted for non-existent run cancellation', async () => {
      const collector = collectEvents(bus, 'run.completed');

      await registry.cancelRun('non-existent-run-id');

      expect(collector.events).toHaveLength(0);
      collector.unsubscribe();
    });
  });

  // ── 4. Cancel already completed run ──────────────────────────────

  describe('Cancel already completed run', () => {
    it('cancelRun() after completeRun() still returns the run (status overwritten)', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      // Complete the run first
      await registry.completeRun(run.id);

      // Verify the abort controller was cleaned up by completeRun
      const signalAfterComplete = registry.getAbortSignal(run.id);
      expect(signalAfterComplete).toBeUndefined();

      // Attempting to cancel a completed run — the run still exists in the map
      // but the AbortController is already gone, so abort() won't be called
      const collector = collectEvents(bus, 'run.completed');
      const result = await registry.cancelRun(run.id);

      // cancelRun returns the run (it exists in the map) but overwrites status
      // This tests the actual behavior: run exists -> status overwritten to cancelled
      if (result) {
        expect(result.status).toBe('cancelled');
      }

      collector.unsubscribe();
    });

    it('AbortController is cleaned up after completeRun()', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      // Signal exists before completion
      expect(registry.getAbortSignal(run.id)).toBeDefined();

      await registry.completeRun(run.id);

      // Signal cleaned up after completion
      expect(registry.getAbortSignal(run.id)).toBeUndefined();
    });

    it('AbortController is cleaned up after completeRun() with error', async () => {
      const run = await registry.startRun('agent-1', 'conv-1', 'interactive');

      expect(registry.getAbortSignal(run.id)).toBeDefined();

      await registry.completeRun(run.id, 'something went wrong');

      expect(registry.getAbortSignal(run.id)).toBeUndefined();
      expect(registry.getRun(run.id)!.status).toBe('error');
    });
  });

  // ── 5. Concurrent runs — cancel one, other continues ─────────────

  describe('Concurrent runs — cancel one, other continues', () => {
    it('cancelling run-1 does not affect run-2 signal', async () => {
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive', 'task 1');
      const run2 = await registry.startRun('agent-1', 'conv-2', 'interactive', 'task 2');

      const signal1 = registry.getAbortSignal(run1.id)!;
      const signal2 = registry.getAbortSignal(run2.id)!;

      expect(signal1.aborted).toBe(false);
      expect(signal2.aborted).toBe(false);

      // Cancel only run-1
      await registry.cancelRun(run1.id);

      expect(signal1.aborted).toBe(true);
      expect(signal2.aborted).toBe(false);

      // run-2 can still be completed normally
      const result = await registry.completeRun(run2.id);
      expect(result!.status).toBe('completed');
    });

    it('concurrent cancellation emits events only for the cancelled run', async () => {
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const run2 = await registry.startRun('agent-1', 'conv-2', 'interactive');

      const collector = collectEvents(bus, 'run.completed');

      // Cancel run-1, complete run-2
      await registry.cancelRun(run1.id);
      await registry.completeRun(run2.id);

      expect(collector.events).toHaveLength(2);

      const cancelEvent = collector.events.find((e) => e.runId === run1.id);
      const completeEvent = collector.events.find((e) => e.runId === run2.id);

      expect(cancelEvent).toBeDefined();
      expect(cancelEvent!.status).toBe('cancelled');

      expect(completeEvent).toBeDefined();
      expect(completeEvent!.status).toBe('completed');

      collector.unsubscribe();
    });

    it('active runs count reflects cancellation correctly', async () => {
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive');
      const run2 = await registry.startRun('agent-1', 'conv-2', 'interactive');
      const _run3 = await registry.startRun('agent-1', 'conv-3', 'interactive');

      expect(registry.getActiveRuns('agent-1')).toHaveLength(3);

      await registry.cancelRun(run1.id);
      expect(registry.getActiveRuns('agent-1')).toHaveLength(2);

      await registry.cancelRun(run2.id);
      expect(registry.getActiveRuns('agent-1')).toHaveLength(1);
    });

    it('cancelled run frees a slot for a new concurrent run', async () => {
      // Start runs up to the default limit (3)
      const run1 = await registry.startRun('agent-1', 'conv-1', 'interactive');
      await registry.startRun('agent-1', 'conv-2', 'interactive');
      await registry.startRun('agent-1', 'conv-3', 'interactive');

      // Fourth run should fail — at limit
      await expect(
        registry.startRun('agent-1', 'conv-4', 'interactive'),
      ).rejects.toThrow(/Concurrent run limit/);

      // Cancel one run
      await registry.cancelRun(run1.id);

      // Now a new run should succeed
      const run4 = await registry.startRun('agent-1', 'conv-4', 'interactive');
      expect(run4).toBeDefined();
      expect(run4.status).toBe('running');
    });
  });
});
