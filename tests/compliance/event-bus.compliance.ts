/**
 * EventBus Interface Compliance Suite
 *
 * Tests that any implementation of TypedEventBus satisfies the
 * behavioral contract. Consumers provide a factory that returns
 * a fresh bus instance.
 *
 * Pattern follows the shared compliance-suite factory style.
 */

import { describe, it, expect, vi } from 'vitest';
import type { TypedEventBus, EventMap } from '../../packages/stablehand/src/events/bus.js';
import {
  makeTurnStartedEvent,
  makeTurnCompletedEvent,
} from '../utils/event-bus-test-helpers.js';

// ── Compliance suite options ────────────────────────────────────

export interface EventBusComplianceOptions {
  /** Creates a fresh bus instance for each test. */
  createBus: () => TypedEventBus | Promise<TypedEventBus>;
}

// ── Compliance suite ────────────────────────────────────────────

export function eventBusComplianceSuite(opts: EventBusComplianceOptions): void {
  // ── emit / handler contract ─────────────────────────────────

  describe('EventBus emit / handler contract', () => {
    it('emit → all handlers receive payload', async () => {
      const bus = await opts.createBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('turn.started', h1);
      bus.on('turn.started', h2);

      const payload = makeTurnStartedEvent();
      bus.emit('turn.started', payload);

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      expect(h1).toHaveBeenCalledWith(payload);
      expect(h2).toHaveBeenCalledWith(payload);
    });

    it('handler receives exact payload fields', async () => {
      const bus = await opts.createBus();
      const received: EventMap['turn.started'][] = [];
      bus.on('turn.started', (p) => received.push(p));

      const payload = makeTurnStartedEvent({
        turnId: 'exact-turn',
        sandboxSessionId: 'exact-sandbox-session',
        agentId: 'exact-agent',
        conversationId: 'exact-conv',
        mode: 'background',
        taskDescription: 'exact task',
      });
      bus.emit('turn.started', payload);

      expect(received).toHaveLength(1);
      expect(received[0]!.turnId).toBe('exact-turn');
      expect(received[0]!.sandboxSessionId).toBe('exact-sandbox-session');
      expect(received[0]!.agentId).toBe('exact-agent');
      expect(received[0]!.conversationId).toBe('exact-conv');
      expect(received[0]!.mode).toBe('background');
      expect(received[0]!.taskDescription).toBe('exact task');
    });

    it('timestamp auto-filled if missing', async () => {
      const bus = await opts.createBus();
      const received: EventMap['turn.started'][] = [];
      bus.on('turn.started', (p) => received.push(p));

      const payload = makeTurnStartedEvent({ timestamp: 0 });
      bus.emit('turn.started', payload);

      expect(received).toHaveLength(1);
      expect(received[0]!.timestamp).toBeGreaterThan(0);
    });

    it('timestamp preserved if provided', async () => {
      const bus = await opts.createBus();
      const received: EventMap['turn.started'][] = [];
      bus.on('turn.started', (p) => received.push(p));

      const payload = makeTurnStartedEvent({ timestamp: 12345 });
      bus.emit('turn.started', payload);

      expect(received).toHaveLength(1);
      expect(received[0]!.timestamp).toBe(12345);
    });
  });

  // ── once() contract ─────────────────────────────────────────

  describe('EventBus once() contract', () => {
    it('once() called exactly once', async () => {
      const bus = await opts.createBus();
      const handler = vi.fn();
      bus.once('turn.started', handler);

      bus.emit('turn.started', makeTurnStartedEvent());
      bus.emit('turn.started', makeTurnStartedEvent());

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ── off() / removeAllListeners contract ─────────────────────

  describe('EventBus off() / removeAllListeners contract', () => {
    it('off() removes handler', async () => {
      const bus = await opts.createBus();
      const handler = vi.fn();
      bus.on('turn.started', handler);
      bus.off('turn.started', handler);

      bus.emit('turn.started', makeTurnStartedEvent());

      expect(handler).not.toHaveBeenCalled();
    });

    it('removeAllListeners(event) scoped — only removes specified event', async () => {
      const bus = await opts.createBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('turn.started', h1);
      bus.on('turn.completed', h2);

      bus.removeAllListeners('turn.started');

      bus.emit('turn.started', makeTurnStartedEvent());
      bus.emit('turn.completed', makeTurnCompletedEvent());

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('removeAllListeners() removes all', async () => {
      const bus = await opts.createBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      bus.on('turn.started', h1);
      bus.on('turn.completed', h2);

      bus.removeAllListeners();

      bus.emit('turn.started', makeTurnStartedEvent());
      bus.emit('turn.completed', makeTurnCompletedEvent());

      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
    });
  });

  // ── Error isolation ─────────────────────────────────────────

  describe('EventBus error isolation', () => {
    it('emit with no handlers does not throw', async () => {
      const bus = await opts.createBus();
      expect(() => {
        bus.emit('agent.created', makeTurnStartedEvent() as any);
      }).not.toThrow();
    });

    it('handler sync error does not crash bus — second handler still called', async () => {
      const bus = await opts.createBus();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const h1 = vi.fn(() => {
        throw new Error('sync boom');
      });
      const h2 = vi.fn();
      bus.on('turn.started', h1);
      bus.on('turn.started', h2);

      bus.emit('turn.started', makeTurnStartedEvent());

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
    });

    it('handler async rejection does not crash bus — second handler still called', async () => {
      const bus = await opts.createBus();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const h1 = vi.fn(async () => {
        throw new Error('async boom');
      });
      const h2 = vi.fn();
      bus.on('turn.started', h1);
      bus.on('turn.started', h2);

      bus.emit('turn.started', makeTurnStartedEvent());

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);

      // Allow the async rejection to be caught
      await new Promise((r) => setTimeout(r, 10));
      errSpy.mockRestore();
    });
  });

  // ── onAgent filtering ───────────────────────────────────────

  describe('EventBus onAgent filtering', () => {
    it('onAgent filters by agentId', async () => {
      const bus = await opts.createBus();
      const handler = vi.fn();
      bus.onAgent('turn.started', 'a1', handler);

      bus.emit('turn.started', makeTurnStartedEvent({ agentId: 'a1' }));
      bus.emit('turn.started', makeTurnStartedEvent({ agentId: 'a2' }));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0].agentId).toBe('a1');
    });

    it('onAgent unsubscribe function works', async () => {
      const bus = await opts.createBus();
      const handler = vi.fn();
      const unsub = bus.onAgent('turn.started', 'a1', handler);

      unsub();

      bus.emit('turn.started', makeTurnStartedEvent({ agentId: 'a1' }));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ── Ordering and safety ─────────────────────────────────────

  describe('EventBus ordering and safety', () => {
    it('multiple handlers called in registration order', async () => {
      const bus = await opts.createBus();
      const order: number[] = [];
      bus.on('turn.started', () => order.push(1));
      bus.on('turn.started', () => order.push(2));
      bus.on('turn.started', () => order.push(3));

      bus.emit('turn.started', makeTurnStartedEvent());

      expect(order).toEqual([1, 2, 3]);
    });

    it('handler registration during emit is safe', async () => {
      const bus = await opts.createBus();
      const laterHandler = vi.fn();
      bus.on('turn.started', () => {
        // Register a new handler during emit
        bus.on('turn.started', laterHandler);
      });

      // Should not crash
      expect(() => {
        bus.emit('turn.started', makeTurnStartedEvent());
      }).not.toThrow();

      // The laterHandler may or may not be called for the current emit,
      // but a second emit should definitely call it
      bus.emit('turn.started', makeTurnStartedEvent());
      expect(laterHandler).toHaveBeenCalled();
    });
  });
}
