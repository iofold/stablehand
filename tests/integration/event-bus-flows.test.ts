/**
 * Event Bus Integration Flow Tests (Phase 3, Task 5)
 *
 * Wires real TypedEventBus + real SSEBroadcaster + real LearningEventSubscriber
 * with mock externals (SSEManager, LearningPipeline, DatabaseRepository).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { SSEBroadcaster } from '../../packages/ctxmill/src/orchestrator/sse-broadcaster.js';
import { LearningEventSubscriber } from '../../packages/ctxmill/src/learning/event-subscriber.js';
import { RunRegistry } from '../../packages/ctxmill/src/orchestrator/run-registry.js';
import {
  createTestBus,
  collectEvents,
  waitForEmit,
  createMockSSEManager,
  createMockDatabase,
  createMockLearningPipeline,
  makeRunStartedEvent,
  makeRunCompletedEvent,
  makeTextChunkEvent,
  makeFeedbackReceivedEvent,
} from '../../tests/utils/event-bus-test-helpers.js';

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('Event Bus Integration Flows', () => {
  let bus: TypedEventBus;
  let mockSSE: ReturnType<typeof createMockSSEManager>;
  let mockDB: ReturnType<typeof createMockDatabase>;
  let mockPipeline: ReturnType<typeof createMockLearningPipeline>;
  let broadcaster: SSEBroadcaster;
  let subscriber: LearningEventSubscriber;

  beforeEach(() => {
    allowConsoleErrors();
    bus = createTestBus();
    mockSSE = createMockSSEManager();
    mockDB = createMockDatabase();
    mockPipeline = createMockLearningPipeline();

    // Wire real subscribers with mock externals
    broadcaster = new SSEBroadcaster(mockSSE as any, bus);
    subscriber = new LearningEventSubscriber(mockPipeline as any, bus, mockDB as any);
  });

  afterEach(() => {
    broadcaster.shutdown();
    subscriber.shutdown();
  });

  // ── Run lifecycle → SSE broadcast ──────────────────────────────

  describe('Run lifecycle → SSE broadcast', () => {
    it('emit run.started → SSEManager.broadcast called with RUN_STARTED', () => {
      const event = makeRunStartedEvent();
      bus.emit('run.started', event);

      expect(mockSSE.broadcast).toHaveBeenCalledTimes(1);
      expect(mockSSE.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_STARTED', internalType: 'run.started' }),
      );
    });

    it('emit run.text_chunk x3 → 3 broadcasts with TEXT_MESSAGE_CONTENT', () => {
      for (let i = 0; i < 3; i++) {
        bus.emit('run.text_chunk', makeTextChunkEvent({ content: `chunk-${i}` }));
      }

      expect(mockSSE.broadcast).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i++) {
        expect(mockSSE.broadcast.mock.calls[i][1]).toEqual(
          expect.objectContaining({ type: 'TEXT_MESSAGE_CONTENT' }),
        );
      }
    });

    it('emit run.completed → broadcast with RUN_FINISHED', () => {
      const event = makeRunCompletedEvent();
      bus.emit('run.completed', event);

      expect(mockSSE.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_FINISHED', internalType: 'run.completed' }),
      );
    });
  });

  // ── Run completion → learning trigger ──────────────────────────

  describe('Run completion → learning trigger', () => {
    it('emit run.completed status=completed → pipeline.process called with trace', async () => {
      const event = makeRunCompletedEvent({ status: 'completed' });

      // Mock DB to return a matching trace
      (mockDB.getRecentTraces as any) = vi.fn().mockResolvedValue([
        {
          id: 'trace-1',
          agentId: event.agentId,
          runId: event.runId,
          taskDescription: 'Test task',
          steps: [],
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          outcome: 'success',
        },
      ]);

      // Rebuild subscriber with updated mock
      subscriber.shutdown();
      subscriber = new LearningEventSubscriber(mockPipeline as any, bus, mockDB as any);

      bus.emit('run.completed', event);
      await settle();

      expect(mockPipeline.process).toHaveBeenCalledTimes(1);
      expect(mockPipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({ runId: event.runId, agentId: event.agentId }),
      );
    });

    it('emit run.completed status=error → pipeline NOT called', async () => {
      const event = makeRunCompletedEvent({ status: 'error', error: 'Something broke' });

      bus.emit('run.completed', event);
      await settle();

      expect(mockPipeline.process).not.toHaveBeenCalled();
    });
  });

  // ── Feedback → learning with signals ───────────────────────────

  describe('Feedback → learning with signals', () => {
    it('emit feedback.received → pipeline.process called with trace + feedback signals', async () => {
      const event = makeFeedbackReceivedEvent({ runId: 'run-fb-1', agentId: 'agent-fb-1' });

      // Mock DB to return matching trace and feedback rows
      (mockDB.getRecentTraces as any) = vi.fn().mockResolvedValue([
        {
          id: 'trace-fb-1',
          agentId: 'agent-fb-1',
          runId: 'run-fb-1',
          taskDescription: 'Feedback task',
          steps: [],
          startedAt: Date.now() - 2000,
          completedAt: Date.now() - 1000,
          outcome: 'success',
        },
      ]);
      (mockDB.getFeedbackForTrace as any) = vi.fn().mockResolvedValue([
        {
          id: 'fb-row-1',
          traceId: 'trace-fb-1',
          agentId: 'agent-fb-1',
          source: 'human',
          type: 'thumbs',
          value: 1,
          createdAt: Date.now(),
        },
      ]);

      // Rebuild subscriber with updated mock
      subscriber.shutdown();
      subscriber = new LearningEventSubscriber(mockPipeline as any, bus, mockDB as any);

      bus.emit('feedback.received', event);
      await settle();

      expect(mockPipeline.process).toHaveBeenCalledTimes(1);
      expect(mockPipeline.process).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-fb-1' }),
        expect.arrayContaining([
          expect.objectContaining({ source: 'human', type: 'thumbs', value: 1 }),
        ]),
      );
    });
  });

  // ── Error isolation between subscribers ────────────────────────

  describe('Error isolation between subscribers', () => {
    it('SSE broadcast throws → learning pipeline still called', async () => {
      mockSSE.broadcast.mockImplementation(() => {
        throw new Error('SSE exploded');
      });

      const event = makeRunCompletedEvent({ status: 'completed' });

      // Mock DB for learning subscriber
      (mockDB.getRecentTraces as any) = vi.fn().mockResolvedValue([
        {
          id: 'trace-err-1',
          agentId: event.agentId,
          runId: event.runId,
          taskDescription: 'Error test',
          steps: [],
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          outcome: 'success',
        },
      ]);

      subscriber.shutdown();
      subscriber = new LearningEventSubscriber(mockPipeline as any, bus, mockDB as any);

      // Suppress expected console.error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bus.emit('run.completed', event);
      await settle();

      expect(mockPipeline.process).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('learning pipeline throws → SSE broadcast still happened', async () => {
      mockPipeline.process.mockRejectedValue(new Error('Pipeline exploded'));

      const event = makeRunCompletedEvent({ status: 'completed' });

      (mockDB.getRecentTraces as any) = vi.fn().mockResolvedValue([
        {
          id: 'trace-err-2',
          agentId: event.agentId,
          runId: event.runId,
          taskDescription: 'Error test 2',
          steps: [],
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          outcome: 'success',
        },
      ]);

      subscriber.shutdown();
      subscriber = new LearningEventSubscriber(mockPipeline as any, bus, mockDB as any);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bus.emit('run.completed', event);
      await settle();

      // SSE broadcast should have happened regardless
      expect(mockSSE.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_FINISHED' }),
      );
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('both throw → no unhandled rejections', async () => {
      mockSSE.broadcast.mockImplementation(() => {
        throw new Error('SSE exploded');
      });
      mockPipeline.process.mockRejectedValue(new Error('Pipeline exploded'));

      const event = makeRunCompletedEvent({ status: 'completed' });

      (mockDB.getRecentTraces as any) = vi.fn().mockResolvedValue([
        {
          id: 'trace-err-3',
          agentId: event.agentId,
          runId: event.runId,
          taskDescription: 'Error test 3',
          steps: [],
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          outcome: 'success',
        },
      ]);

      subscriber.shutdown();
      subscriber = new LearningEventSubscriber(mockPipeline as any, bus, mockDB as any);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // This should not throw or cause unhandled rejections
      expect(() => bus.emit('run.completed', event)).not.toThrow();
      await settle();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ── RunRegistry event emission ─────────────────────────────────

  describe('RunRegistry event emission', () => {
    it('startRun() → run.started received by collector', async () => {
      const collector = collectEvents(bus, 'run.started');
      const registry = new RunRegistry(undefined, bus);

      await registry.startRun('agent-reg-1', 'conv-reg-1', 'interactive', 'Registry test');

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          agentId: 'agent-reg-1',
          conversationId: 'conv-reg-1',
          mode: 'interactive',
          taskDescription: 'Registry test',
        }),
      );

      collector.unsubscribe();
    });

    it('completeRun() → run.completed received with correct status', async () => {
      const registry = new RunRegistry(undefined, bus);
      const run = await registry.startRun('agent-reg-2', 'conv-reg-2', 'background');

      const collector = collectEvents(bus, 'run.completed');
      await registry.completeRun(run.id);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          runId: run.id,
          agentId: 'agent-reg-2',
          status: 'completed',
        }),
      );

      collector.unsubscribe();
    });

    it('cancelRun() → run.completed received with status cancelled', async () => {
      const registry = new RunRegistry(undefined, bus);
      const run = await registry.startRun('agent-reg-3', 'conv-reg-3', 'interactive');

      const collector = collectEvents(bus, 'run.completed');
      await registry.cancelRun(run.id);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          runId: run.id,
          agentId: 'agent-reg-3',
          status: 'cancelled',
        }),
      );

      collector.unsubscribe();
    });
  });

  // ── Event persistence ──────────────────────────────────────────

  describe('Event persistence', () => {
    it('emit with persistEvent callback → callback called with correct args', () => {
      const persistFn = vi.fn();
      const persistBus = createTestBus({ persistEvent: persistFn });

      // Re-wire broadcaster/subscriber on this bus
      const localBroadcaster = new SSEBroadcaster(mockSSE as any, persistBus);

      const event = makeRunStartedEvent({ runId: 'run-persist-1', agentId: 'agent-persist-1' });
      persistBus.emit('run.started', event);

      expect(persistFn).toHaveBeenCalledTimes(1);
      expect(persistFn).toHaveBeenCalledWith(
        'run.started',
        'agent-persist-1',
        expect.any(String),
      );

      // Verify the JSON payload is valid
      const payloadJson = persistFn.mock.calls[0][2];
      const parsed = JSON.parse(payloadJson);
      expect(parsed.runId).toBe('run-persist-1');

      localBroadcaster.shutdown();
    });

    it('persist error → event still delivered to handlers', () => {
      const persistFn = vi.fn().mockImplementation(() => {
        throw new Error('Persist failed');
      });
      const persistBus = createTestBus({ persistEvent: persistFn });

      const collector = collectEvents(persistBus, 'run.started');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const event = makeRunStartedEvent();
      persistBus.emit('run.started', event);

      // Event should still be delivered despite persist error
      expect(collector.events).toHaveLength(1);
      expect(collector.events[0].runId).toBe(event.runId);

      collector.unsubscribe();
      consoleSpy.mockRestore();
    });
  });
});
