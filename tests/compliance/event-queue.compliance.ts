/**
 * EventQueue Interface Compliance Suite
 *
 * Tests that any implementation of the EventQueue interface satisfies
 * the behavioral contract. Consumers provide a factory that returns
 * a fresh queue instance.
 *
 * Pattern follows learning-pipeline.compliance.ts and event-bus.compliance.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventQueue } from '../../packages/ctxmill/src/events/event-queue.js';
import { EventTimeoutError } from '../../packages/ctxmill/src/events/wait-for-event.js';

// ── Compliance suite options ────────────────────────────────────

export interface EventQueueComplianceOptions {
  /** Creates a fresh queue instance for each test. */
  createQueue: () => EventQueue | Promise<EventQueue>;
  /** Optional cleanup after each test. */
  cleanup?: () => Promise<void>;
}

// ── Compliance suite ────────────────────────────────────────────

export function eventQueueComplianceSuite(opts: EventQueueComplianceOptions): void {
  let queue: EventQueue;

  beforeEach(async () => {
    queue = await opts.createQueue();
  });

  afterEach(async () => {
    await queue.shutdown();
    if (opts.cleanup) {
      await opts.cleanup();
    }
  });

  // ── enqueue contract ──────────────────────────────────────────

  describe('EventQueue enqueue contract', () => {
    it('enqueue returns event ID string', async () => {
      const id = await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'test',
          timestamp: Date.now(),
        },
      });

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  // ── subscribe contract ────────────────────────────────────────

  describe('EventQueue subscribe contract', () => {
    it('subscribe receives enqueued events', async () => {
      const received: unknown[] = [];
      queue.subscribe('run.started', (payload) => {
        received.push(payload);
      });

      await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'test',
          timestamp: Date.now(),
        },
      });

      expect(received).toHaveLength(1);
      expect((received[0] as any).runId).toBe('r1');
    });

    it('subscribe returns working unsubscribe function', async () => {
      const received: unknown[] = [];
      const unsub = queue.subscribe('run.started', (payload) => {
        received.push(payload);
      });

      unsub();

      await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'test',
          timestamp: Date.now(),
        },
      });

      expect(received).toHaveLength(0);
    });
  });

  // ── waitFor contract ──────────────────────────────────────────

  describe('EventQueue waitFor contract', () => {
    it('waitFor resolves on matching event', async () => {
      const promise = queue.waitFor(
        'run.started',
        (p) => p.runId === 'r1',
        5000,
      );

      await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'test',
          timestamp: Date.now(),
        },
      });

      const result = await promise;
      expect(result.runId).toBe('r1');
    });

    it('waitFor rejects on timeout', async () => {
      vi.useFakeTimers();
      try {
        const promise = queue.waitFor(
          'run.started',
          () => true,
          100,
        );

        vi.advanceTimersByTime(200);

        await expect(promise).rejects.toThrow(EventTimeoutError);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waitFor with predicate filters correctly', async () => {
      const promise = queue.waitFor(
        'run.started',
        (p) => p.runId === 'r2',
        5000,
      );

      // Enqueue non-matching event first
      await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'test',
          timestamp: Date.now(),
        },
      });

      // Enqueue matching event
      await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r2',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'test',
          timestamp: Date.now(),
        },
      });

      const result = await promise;
      expect(result.runId).toBe('r2');
    });
  });

  // ── getEventsSince contract ───────────────────────────────────

  describe('EventQueue getEventsSince contract', () => {
    it('getEventsSince returns events after cursor', async () => {
      const id1 = await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'first',
          timestamp: Date.now(),
        },
      });

      await queue.enqueue({
        type: 'run.completed',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          status: 'completed',
          durationMs: 100,
          timestamp: Date.now(),
        },
      });

      const events = await queue.getEventsSince('agent-1', id1, 100);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('run.completed');
    });

    it('getEventsSince respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await queue.enqueue({
          type: 'run.text_chunk',
          agentId: 'agent-1',
          payload: {
            runId: 'r1',
            agentId: 'agent-1',
            messageId: `msg-${i}`,
            content: `chunk ${i}`,
            timestamp: Date.now(),
          },
        });
      }

      const events = await queue.getEventsSince('agent-1', 0, 3);
      expect(events).toHaveLength(3);
    });

    it('getEventsSince returns empty for unknown agent', async () => {
      await queue.enqueue({
        type: 'run.started',
        agentId: 'agent-1',
        payload: {
          runId: 'r1',
          agentId: 'agent-1',
          conversationId: 'c1',
          mode: 'interactive',
          taskDescription: 'test',
          timestamp: Date.now(),
        },
      });

      const events = await queue.getEventsSince('unknown-agent', 0, 100);
      expect(events).toHaveLength(0);
    });
  });

  // ── scheduleAt contract ───────────────────────────────────────

  describe('EventQueue scheduleAt contract', () => {
    it('scheduleAt stores event for future execution', async () => {
      const future = new Date(Date.now() + 60_000);
      const id = await queue.scheduleAt(
        {
          type: 'run.started',
          agentId: 'agent-1',
          payload: {
            runId: 'r-scheduled',
            agentId: 'agent-1',
            conversationId: 'c1',
            mode: 'interactive',
            taskDescription: 'scheduled task',
            timestamp: Date.now(),
          },
        },
        future,
      );

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('scheduled event fires after wake time', async () => {
      // Shut down the queue created with real timers, recreate with fake timers
      await queue.shutdown();
      vi.useFakeTimers();
      try {
        queue = await opts.createQueue();

        const received: unknown[] = [];
        queue.subscribe('run.started', (payload) => {
          received.push(payload);
        });

        const past = new Date(Date.now() - 1000);
        await queue.scheduleAt(
          {
            type: 'run.started',
            agentId: 'agent-1',
            payload: {
              runId: 'r-scheduled',
              agentId: 'agent-1',
              conversationId: 'c1',
              mode: 'interactive',
              taskDescription: 'scheduled task',
              timestamp: Date.now(),
            },
          },
          past,
        );

        // Advance past the 30s polling interval
        await vi.advanceTimersByTimeAsync(31_000);

        expect(received.length).toBeGreaterThanOrEqual(1);
        expect((received[0] as any).runId).toBe('r-scheduled');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── shutdown contract ─────────────────────────────────────────

  describe('EventQueue shutdown contract', () => {
    it('shutdown stops polling and cleans up', async () => {
      // Shut down the queue created with real timers, recreate with fake timers
      await queue.shutdown();
      vi.useFakeTimers();
      try {
        queue = await opts.createQueue();

        const received: unknown[] = [];
        queue.subscribe('run.started', (payload) => {
          received.push(payload);
        });

        await queue.shutdown();

        // Schedule an event with past wake time after shutdown
        const past = new Date(Date.now() - 1000);
        await queue.scheduleAt(
          {
            type: 'run.started',
            agentId: 'agent-1',
            payload: {
              runId: 'r-after-shutdown',
              agentId: 'agent-1',
              conversationId: 'c1',
              mode: 'interactive',
              taskDescription: 'should not fire',
              timestamp: Date.now(),
            },
          },
          past,
        );

        // Advance past polling interval — should not fire since shutdown was called
        await vi.advanceTimersByTimeAsync(61_000);

        // No events should have been fired via polling
        expect(received).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
}
