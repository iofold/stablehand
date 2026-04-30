/**
 * Event Bus Integration Flow Tests (Phase 3, Task 5)
 *
 * Wires real TypedEventBus + real SSEBroadcaster with mock SSE externals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { SSEBroadcaster } from '../../packages/ctxmill/src/orchestrator/sse-broadcaster.js';
import { TestSessionRegistry } from '../utils/test-session-registry.js';
import {
  createTestBus,
  collectEvents,
  createMockSSEManager,
  makeRunStartedEvent,
  makeRunCompletedEvent,
  makeTextChunkEvent,
} from '../../tests/utils/event-bus-test-helpers.js';

describe('Event Bus Integration Flows', () => {
  let bus: TypedEventBus;
  let mockSSE: ReturnType<typeof createMockSSEManager>;
  let broadcaster: SSEBroadcaster;

  beforeEach(() => {
    bus = createTestBus();
    mockSSE = createMockSSEManager();
    broadcaster = new SSEBroadcaster(mockSSE as any, bus);
  });

  afterEach(() => {
    broadcaster.shutdown();
  });

  // ── Run lifecycle → SSE broadcast ──────────────────────────────

  describe('Run lifecycle → SSE broadcast', () => {
    it('emit run.started → SSEManager.broadcast called with RUN_STARTED', () => {
      const event = makeRunStartedEvent();
      bus.emit('turn.started', event);

      expect(mockSSE.broadcast).toHaveBeenCalledTimes(1);
      expect(mockSSE.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_STARTED', internalType: 'turn.started' }),
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
      bus.emit('turn.completed', event);

      expect(mockSSE.broadcast).toHaveBeenCalledWith(
        event.agentId,
        expect.objectContaining({ type: 'RUN_FINISHED', internalType: 'turn.completed' }),
      );
    });
  });

  // ── RunRegistry event emission ─────────────────────────────────

  describe('RunRegistry event emission', () => {
    it('startRun() → run.started received by collector', async () => {
      const collector = collectEvents(bus, 'turn.started');
      const registry = new TestSessionRegistry(undefined, bus);

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
      const registry = new TestSessionRegistry(undefined, bus);
      const run = await registry.startRun('agent-reg-2', 'conv-reg-2', 'background');

      const collector = collectEvents(bus, 'turn.completed');
      await registry.completeRun(run.id);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
            sessionId: run.id,
            turnId: run.id,
            agentId: 'agent-reg-2',
            status: 'completed',
        }),
      );

      collector.unsubscribe();
    });

    it('cancelRun() → run.completed received with status cancelled', async () => {
      const registry = new TestSessionRegistry(undefined, bus);
      const run = await registry.startRun('agent-reg-3', 'conv-reg-3', 'interactive');

      const collector = collectEvents(bus, 'turn.completed');
      await registry.cancelRun(run.id);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
            sessionId: run.id,
            turnId: run.id,
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

      const event = makeRunStartedEvent({ turnId: 'run-persist-1', sessionId: 'run-persist-1', agentId: 'agent-persist-1' });
      persistBus.emit('turn.started', event);

      expect(persistFn).toHaveBeenCalledTimes(1);
      expect(persistFn).toHaveBeenCalledWith(
        'turn.started',
        'agent-persist-1',
        expect.any(String),
      );

      // Verify the JSON payload is valid
      const payloadJson = persistFn.mock.calls[0][2];
      const parsed = JSON.parse(payloadJson);
      expect(parsed.sessionId).toBe('run-persist-1');

      localBroadcaster.shutdown();
    });

    it('persist error → event still delivered to handlers', () => {
      const persistFn = vi.fn().mockImplementation(() => {
        throw new Error('Persist failed');
      });
      const persistBus = createTestBus({ persistEvent: persistFn });

      const collector = collectEvents(persistBus, 'turn.started');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const event = makeRunStartedEvent();
      persistBus.emit('turn.started', event);

      // Event should still be delivered despite persist error
      expect(collector.events).toHaveLength(1);
      expect(collector.events[0].sessionId).toBe(event.sessionId);

      collector.unsubscribe();
      consoleSpy.mockRestore();
    });
  });
});
