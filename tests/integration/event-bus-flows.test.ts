/**
 * Event Bus Integration Flow Tests
 *
 * Wires a real TypedEventBus into the canonical event spine (ADR-015) and
 * asserts the run-channel wire it produces.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestTurnRegistry } from '../utils/test-turn-registry.js';
import {
  createTestBus,
  createCanonicalWireHarness,
  collectEvents,
  flushWire,
  makeTurnStartedEvent,
  makeTurnCompletedEvent,
  makeMessageDeltaEvent,
} from '../../tests/utils/event-bus-test-helpers.js';

describe('Event Bus Integration Flows', () => {
  let harness: ReturnType<typeof createCanonicalWireHarness>;

  beforeEach(() => {
    harness = createCanonicalWireHarness();
  });

  // ── Run lifecycle → canonical wire ─────────────────────────────

  describe('Turn lifecycle → canonical wire', () => {
    it('emit turn.started → RUN_STARTED frame on the wire', async () => {
      const event = makeTurnStartedEvent();
      harness.bus.emit('turn.started', event);
      await flushWire();

      expect(harness.wire).toHaveLength(1);
      expect(harness.wire[0]).toEqual({
        agentId: event.agentId,
        event: expect.objectContaining({ type: 'RUN_STARTED', runId: event.turnId }),
      });
    });

    it('emit message.delta x3 → one TEXT_MESSAGE_START boundary + 3 CONTENT frames with a stable messageId', async () => {
      for (let i = 0; i < 3; i++) {
        harness.bus.emit('message.delta', makeMessageDeltaEvent({ delta: `chunk-${i}` }));
      }
      await flushWire();

      const types = harness.wire.map((entry) => entry.event.type);
      expect(types).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT']);
      const messageIds = new Set(harness.wire.map((entry) => entry.event.messageId));
      expect(messageIds.size).toBe(1);
    });

    it('emit turn.completed → RUN_FINISHED frame with status', async () => {
      const event = makeTurnCompletedEvent();
      harness.bus.emit('turn.completed', event);
      await flushWire();

      expect(harness.wire.map((entry) => entry.event.type)).toEqual(['RUN_FINISHED']);
      expect(harness.wire[0]!.event.status).toBe(event.status);
    });
  });

  // ── TurnRegistry event emission ────────────────────────────────

  describe('TurnRegistry event emission', () => {
    it('startTurn() → turn.started received by collector', async () => {
      const bus = createTestBus();
      const collector = collectEvents(bus, 'turn.started');
      const registry = new TestTurnRegistry(bus);

      await registry.startTurn('agent-reg-1', 'conv-reg-1', 'interactive', 'Registry test');

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

    it('completeTurn() → turn.completed received with correct status', async () => {
      const bus = createTestBus();
      const registry = new TestTurnRegistry(bus);
      const turn = await registry.startTurn('agent-reg-2', 'conv-reg-2', 'background');

      const collector = collectEvents(bus, 'turn.completed');
      await registry.completeTurn(turn.turnId);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          sandboxSessionId: turn.sandboxSessionId,
          turnId: turn.turnId,
          agentId: 'agent-reg-2',
          status: 'completed',
        }),
      );

      collector.unsubscribe();
    });

    it('cancelTurn() → turn.completed received with status cancelled', async () => {
      const bus = createTestBus();
      const registry = new TestTurnRegistry(bus);
      const turn = await registry.startTurn('agent-reg-3', 'conv-reg-3', 'interactive');

      const collector = collectEvents(bus, 'turn.completed');
      await registry.cancelTurn(turn.turnId);

      expect(collector.events).toHaveLength(1);
      expect(collector.events[0]).toEqual(
        expect.objectContaining({
          sandboxSessionId: turn.sandboxSessionId,
          turnId: turn.turnId,
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

      const event = makeTurnStartedEvent({
        turnId: 'turn-persist-1',
        sandboxSessionId: 'sandbox-persist-1',
        agentId: 'agent-persist-1',
      });
      persistBus.emit('turn.started', event);

      expect(persistFn).toHaveBeenCalledTimes(1);
      expect(persistFn).toHaveBeenCalledWith(
        'turn.started',
        'agent-persist-1',
        expect.any(String),
        // Parsed payload rides along so persistence layers avoid a re-parse (ADR-015).
        expect.objectContaining({ turnId: 'turn-persist-1' }),
      );

      // Verify the JSON payload is valid
      const payloadJson = persistFn.mock.calls[0][2];
      const parsed = JSON.parse(payloadJson);
      expect(parsed.turnId).toBe('turn-persist-1');
      expect(parsed.sandboxSessionId).toBe('sandbox-persist-1');
    });

    it('persistence failure prevents listener dispatch', () => {
      const persistFn = vi.fn().mockImplementation(() => {
        throw new Error('Persist failed');
      });
      const persistBus = createTestBus({ persistEvent: persistFn });

      const collector = collectEvents(persistBus, 'turn.started');
      const busErrors = collectEvents(persistBus, 'bus.error' as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const event = makeTurnStartedEvent();
      persistBus.emit('turn.started', event);

      expect(collector.events).toHaveLength(0);
      expect(busErrors.events).toHaveLength(1);
      expect(busErrors.events[0]).toEqual(expect.objectContaining({
        source: 'persist',
        event: 'turn.started',
        error: 'Persist failed',
      }));

      collector.unsubscribe();
      busErrors.unsubscribe();
      consoleSpy.mockRestore();
    });

    it('async persistence success dispatches exactly once after persistence', async () => {
      const persistFn = vi.fn(async () => undefined);
      const persistBus = createTestBus({ persistEvent: persistFn });
      const collector = collectEvents(persistBus, 'turn.started');

      const event = makeTurnStartedEvent();
      persistBus.emit('turn.started', event);
      expect(collector.events).toHaveLength(0);

      await Promise.resolve();

      expect(persistFn).toHaveBeenCalledTimes(1);
      expect(collector.events).toHaveLength(1);
      expect(collector.events[0].turnId).toBe(event.turnId);
      expect(collector.events[0].sandboxSessionId).toBe(event.sandboxSessionId);

      collector.unsubscribe();
    });

    it('listener failure does not retroactively mark persistence failed', () => {
      const persistFn = vi.fn();
      const persistBus = createTestBus({ persistEvent: persistFn });
      const busErrors = collectEvents(persistBus, 'bus.error' as never);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      persistBus.on('turn.started', () => {
        throw new Error('listener failed');
      });

      persistBus.emit('turn.started', makeTurnStartedEvent());

      expect(persistFn).toHaveBeenCalledTimes(1);
      expect(busErrors.events).toHaveLength(1);
      expect(busErrors.events[0]).toEqual(expect.objectContaining({
        source: 'handler',
        event: 'turn.started',
        error: 'listener failed',
      }));

      busErrors.unsubscribe();
      consoleSpy.mockRestore();
    });
  });
});
