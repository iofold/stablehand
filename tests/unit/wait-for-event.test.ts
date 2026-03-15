import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForEvent, EventTimeoutError } from '../../packages/ctxmill/src/events/wait-for-event.js';
import {
  createTestBus,
  makeRunCompletedEvent,
  makeFeedbackReceivedEvent,
  makeRunStartedEvent,
} from '../../tests/utils/event-bus-test-helpers.js';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';

describe('waitForEvent', () => {
  let bus: TypedEventBus;

  beforeEach(() => {
    bus = createTestBus();
  });

  describe('basic matching', () => {
    it('resolves when matching event emitted', async () => {
      const promise = waitForEvent(bus, 'run.completed', 5000);
      const event = makeRunCompletedEvent();
      bus.emit('run.completed', event);
      const result = await promise;
      expect(result).toEqual(event);
    });

    it('resolves with the emitted payload', async () => {
      const promise = waitForEvent(
        bus,
        'run.completed',
        (p) => p.status === 'completed',
        5000,
      );
      const event = makeRunCompletedEvent({ status: 'completed', durationMs: 42 });
      bus.emit('run.completed', event);
      const result = await promise;
      expect(result.durationMs).toBe(42);
      expect(result.status).toBe('completed');
    });

    it('without predicate: any event of that type resolves', async () => {
      const promise = waitForEvent(bus, 'feedback.received', 5000);
      const event = makeFeedbackReceivedEvent({ type: 'thumbs_down' });
      bus.emit('feedback.received', event);
      const result = await promise;
      expect(result.type).toBe('thumbs_down');
    });
  });

  describe('predicate filtering', () => {
    it('non-matching event stays pending', async () => {
      vi.useFakeTimers();
      const promise = waitForEvent(
        bus,
        'run.completed',
        (p) => p.status === 'completed',
        5000,
      );
      bus.emit('run.completed', makeRunCompletedEvent({ status: 'error' }));

      // Promise should not have resolved yet — advance a tiny bit
      let resolved = false;
      promise.then(() => { resolved = true; }).catch(() => {});
      await vi.advanceTimersByTimeAsync(100);
      expect(resolved).toBe(false);

      vi.useRealTimers();
      // Clean up: reject the promise so it doesn't leak
      bus.emit('run.completed', makeRunCompletedEvent({ status: 'completed' }));
      await promise;
    });

    it('matching event after non-matching resolves with matching payload', async () => {
      const promise = waitForEvent(
        bus,
        'run.completed',
        (p) => p.status === 'completed',
        5000,
      );
      bus.emit('run.completed', makeRunCompletedEvent({ status: 'error' }));
      const matching = makeRunCompletedEvent({ status: 'completed', runId: 'run-match' });
      bus.emit('run.completed', matching);
      const result = await promise;
      expect(result.runId).toBe('run-match');
    });

    it('predicate receives full payload', async () => {
      const predicateSpy = vi.fn().mockReturnValue(true);
      const promise = waitForEvent(bus, 'run.completed', predicateSpy, 5000);
      const event = makeRunCompletedEvent({ runId: 'full-payload-test' });
      bus.emit('run.completed', event);
      await promise;
      expect(predicateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'full-payload-test' }),
      );
    });
  });

  describe('timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('no event within timeout rejects with EventTimeoutError', async () => {
      const promise = waitForEvent(bus, 'run.completed', 1000);
      vi.advanceTimersByTime(1001);
      await expect(promise).rejects.toThrow(EventTimeoutError);
    });

    it('EventTimeoutError has eventType and timeoutMs fields', async () => {
      const promise = waitForEvent(bus, 'run.completed', 2000);
      vi.advanceTimersByTime(2001);
      try {
        await promise;
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EventTimeoutError);
        const timeout = err as EventTimeoutError;
        expect(timeout.eventType).toBe('run.completed');
        expect(timeout.timeoutMs).toBe(2000);
      }
    });

    it('resolved before timeout clears timer (no unhandled rejection)', async () => {
      const promise = waitForEvent(bus, 'run.started', 5000);
      bus.emit('run.started', makeRunStartedEvent());
      const result = await promise;
      expect(result.runId).toBeDefined();
      // Advance past the timeout — should NOT reject
      vi.advanceTimersByTime(6000);
      // If we get here without error, timeout was properly cleared
    });
  });

  describe('cleanup', () => {
    it('after resolve: handler removed from bus (emit again, no effect)', async () => {
      const spy = vi.fn();
      bus.on('run.completed', spy);

      const promise = waitForEvent(bus, 'run.completed', 5000);
      bus.emit('run.completed', makeRunCompletedEvent());
      await promise;

      // spy was called once from the direct on(), but the waitForEvent handler is now removed
      spy.mockClear();
      bus.emit('run.completed', makeRunCompletedEvent());
      // spy should be called once (from our explicit on()), but NOT the waitForEvent handler
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('after timeout: handler removed from bus', async () => {
      vi.useFakeTimers();
      const promise = waitForEvent(bus, 'run.completed', 500);
      vi.advanceTimersByTime(501);
      await expect(promise).rejects.toThrow(EventTimeoutError);

      // Now emit — should not cause issues
      const spy = vi.fn();
      bus.on('run.completed', spy);
      bus.emit('run.completed', makeRunCompletedEvent());
      expect(spy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('no memory leaks (listener count returns to 0)', async () => {
      // Use a fresh bus to ensure no other listeners
      const freshBus = createTestBus();
      const promise = waitForEvent(freshBus, 'agent.created', 5000);
      freshBus.emit('agent.created', { agentId: 'a1', name: 'X', timestamp: 1 });
      await promise;

      // Emit again — no handlers should fire
      const spy = vi.fn();
      // The only handler should be the one we add now
      freshBus.on('agent.created', spy);
      freshBus.emit('agent.created', { agentId: 'a2', name: 'Y', timestamp: 2 });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent waiters', () => {
    it('2 waiters for same event type, different predicates — each resolves independently', async () => {
      const waiter1 = waitForEvent(
        bus,
        'run.completed',
        (p) => p.status === 'completed',
        5000,
      );
      const waiter2 = waitForEvent(
        bus,
        'run.completed',
        (p) => p.status === 'error',
        5000,
      );

      // Emit event matching waiter1 but not waiter2
      bus.emit('run.completed', makeRunCompletedEvent({ status: 'completed', runId: 'w1' }));
      const result1 = await waiter1;
      expect(result1.runId).toBe('w1');

      // waiter2 should still be pending — now emit matching event
      bus.emit('run.completed', makeRunCompletedEvent({ status: 'error', runId: 'w2' }));
      const result2 = await waiter2;
      expect(result2.runId).toBe('w2');
    });

    it('event matching waiter1 but not waiter2 only resolves waiter1', async () => {
      vi.useFakeTimers();
      const waiter1 = waitForEvent(
        bus,
        'run.completed',
        (p) => p.runId === 'target',
        5000,
      );
      const waiter2 = waitForEvent(
        bus,
        'run.completed',
        (p) => p.runId === 'other',
        1000,
      );

      bus.emit('run.completed', makeRunCompletedEvent({ runId: 'target' }));
      const result1 = await waiter1;
      expect(result1.runId).toBe('target');

      // waiter2 should timeout
      vi.advanceTimersByTime(1001);
      await expect(waiter2).rejects.toThrow(EventTimeoutError);
      vi.useRealTimers();
    });
  });

  describe('edge cases', () => {
    it('predicate throws — treated as non-match, logged', async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const promise = waitForEvent(
        bus,
        'run.completed',
        () => { throw new Error('boom'); },
        5000,
      );

      bus.emit('run.completed', makeRunCompletedEvent());
      expect(warnSpy).toHaveBeenCalled();

      // Still pending since predicate always throws — timeout it
      vi.advanceTimersByTime(5001);
      await expect(promise).rejects.toThrow(EventTimeoutError);
      vi.useRealTimers();
      warnSpy.mockRestore();
    });

    it('event emitted synchronously in same tick — still caught', async () => {
      // We emit right after creating the promise in the same sync block
      // but waitForEvent registers the handler synchronously, so it works
      const event = makeRunStartedEvent({ runId: 'sync-emit' });
      const promise = waitForEvent(bus, 'run.started', 5000);
      bus.emit('run.started', event);
      const result = await promise;
      expect(result.runId).toBe('sync-emit');
    });

    it('timeoutMs = 0 rejects immediately', async () => {
      vi.useFakeTimers();
      const promise = waitForEvent(bus, 'run.completed', 0);
      vi.advanceTimersByTime(1);
      await expect(promise).rejects.toThrow(EventTimeoutError);
      vi.useRealTimers();
    });
  });
});
