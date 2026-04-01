import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallbackDispatcher, getRetryDelay } from '../callback-dispatcher.js';
import type { DatabaseRepository, CallbackOutboxRow } from '../../database/repository.js';

/** Create a minimal mock of DatabaseRepository with only the methods CallbackDispatcher uses. */
function createMockDb() {
  const store = new Map<string, CallbackOutboxRow>();

  const db = {
    enqueueCallback: vi.fn(async (data: any) => {
      const row = { ...data } as CallbackOutboxRow;
      store.set(row.id, row);
      return row;
    }),
    getPendingCallbacks: vi.fn(async (limit: number, beforeTime: number) => {
      const results: CallbackOutboxRow[] = [];
      for (const row of store.values()) {
        if (row.status === 'pending' && row.nextAttemptAt <= beforeTime) {
          results.push(row);
          if (results.length >= limit) break;
        }
      }
      return results;
    }),
    markCallbackDelivered: vi.fn(async (id: string) => {
      const row = store.get(id);
      if (row) {
        row.status = 'delivered';
        row.deliveredAt = Date.now();
      }
    }),
    markCallbackFailed: vi.fn(async (id: string, error: string, nextAttemptAt?: number) => {
      const row = store.get(id);
      if (!row) return;
      row.attempts += 1;
      row.lastAttemptAt = Date.now();
      row.lastError = error;
      if (row.attempts >= row.maxAttempts) {
        row.status = 'failed';
      } else {
        row.nextAttemptAt = nextAttemptAt ?? Date.now();
      }
    }),
    getCallbacksForAgent: vi.fn(async (agentId: string) => {
      return Array.from(store.values()).filter((r) => r.agentId === agentId);
    }),
    /** Expose internal store for assertions */
    _store: store,
  };

  return db as unknown as DatabaseRepository & { _store: Map<string, CallbackOutboxRow> };
}

describe('CallbackDispatcher', () => {
  let db: ReturnType<typeof createMockDb>;
  let dispatcher: CallbackDispatcher;

  beforeEach(() => {
    db = createMockDb();
    dispatcher = new CallbackDispatcher(db, 1000);
  });

  describe('getRetryDelay', () => {
    it('returns correct delays for each attempt', () => {
      expect(getRetryDelay(1)).toBe(0);        // immediate
      expect(getRetryDelay(2)).toBe(5_000);     // 5s
      expect(getRetryDelay(3)).toBe(30_000);    // 30s
      expect(getRetryDelay(4)).toBe(300_000);   // 5min
      expect(getRetryDelay(5)).toBe(1_800_000); // 30min
    });

    it('clamps to max delay for attempts beyond schedule', () => {
      expect(getRetryDelay(10)).toBe(1_800_000);
    });

    it('returns 0 for attempt <= 0', () => {
      expect(getRetryDelay(0)).toBe(0);
      expect(getRetryDelay(-1)).toBe(0);
    });
  });

  describe('enqueue', () => {
    it('creates an outbox entry and returns its ID', async () => {
      const id = await dispatcher.enqueue({
        agentId: 'agent-1',
        sessionId: 'run-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: { status: 'completed' },
      });

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      expect(db.enqueueCallback).toHaveBeenCalledTimes(1);

      const call = (db.enqueueCallback as any).mock.calls[0][0];
      expect(call.agentId).toBe('agent-1');
      expect(call.sessionId).toBe('run-1');
      expect(call.callbackUrl).toBe('https://example.com/hook');
      expect(call.eventType).toBe('turn.completed');
      expect(call.payload).toEqual({ status: 'completed' });
      expect(call.status).toBe('pending');
      expect(call.attempts).toBe(0);
      expect(call.maxAttempts).toBe(5);
    });

    it('sets sessionId to null when not provided', async () => {
      await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'agent.created',
        payload: {},
      });

      const call = (db.enqueueCallback as any).mock.calls[0][0];
      expect(call.sessionId).toBeNull();
    });
  });

  describe('deliver (via processPending)', () => {
    it('marks entry as delivered on successful HTTP response', async () => {
      // Set up a mock fetch that returns 200
      dispatcher.fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });

      await dispatcher.enqueue({
        agentId: 'agent-1',
        sessionId: 'run-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: { status: 'completed' },
      });

      const processed = await dispatcher.processPending();

      expect(processed).toBe(1);
      expect(db.markCallbackDelivered).toHaveBeenCalledTimes(1);
      expect(db.markCallbackFailed).not.toHaveBeenCalled();
    });

    it('sends correct headers and payload', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
      });
      dispatcher.fetchFn = mockFetch;

      const id = await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: { test: true },
      });

      await dispatcher.processPending();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://example.com/hook');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.headers['X-Agent-Id']).toBe('agent-1');
      expect(init.headers['X-Event-Type']).toBe('turn.completed');
      expect(init.headers['X-Delivery-Id']).toBe(id);
      expect(JSON.parse(init.body)).toEqual({ test: true });
    });

    it('marks entry as failed on non-2xx HTTP response', async () => {
      dispatcher.fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: {},
      });

      const processed = await dispatcher.processPending();

      expect(processed).toBe(1);
      expect(db.markCallbackDelivered).not.toHaveBeenCalled();
      expect(db.markCallbackFailed).toHaveBeenCalledTimes(1);

      const [, error] = (db.markCallbackFailed as any).mock.calls[0];
      expect(error).toContain('500');
    });

    it('marks entry as failed on network error', async () => {
      dispatcher.fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: {},
      });

      const processed = await dispatcher.processPending();

      expect(processed).toBe(1);
      expect(db.markCallbackDelivered).not.toHaveBeenCalled();
      expect(db.markCallbackFailed).toHaveBeenCalledTimes(1);

      const [, error] = (db.markCallbackFailed as any).mock.calls[0];
      expect(error).toBe('ECONNREFUSED');
    });
  });

  describe('retry schedule', () => {
    it('increments attempts and schedules next retry on failure', async () => {
      dispatcher.fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: {},
      });

      // First attempt fails
      await dispatcher.processPending();
      expect(db.markCallbackFailed).toHaveBeenCalledTimes(1);

      // Check the nextAttemptAt includes delay for attempt 2
      const [, , nextAttemptAt] = (db.markCallbackFailed as any).mock.calls[0];
      expect(nextAttemptAt).toBeGreaterThan(Date.now() - 1000); // should be roughly now + delay
    });

    it('marks as permanently failed after max attempts', async () => {
      dispatcher.fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      // Create an entry already near max attempts
      const id = await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: {},
      });

      // Simulate 4 prior attempts by directly modifying the store
      const row = db._store.get(id)!;
      row.attempts = 4; // already tried 4 times, max is 5

      await dispatcher.processPending();

      // markCallbackFailed should set status to 'failed'
      expect(db.markCallbackFailed).toHaveBeenCalledTimes(1);
      // After markCallbackFailed, the row should be 'failed'
      expect(row.status).toBe('failed');
    });
  });

  describe('processPending', () => {
    it('returns 0 when no pending callbacks', async () => {
      const processed = await dispatcher.processPending();
      expect(processed).toBe(0);
    });

    it('does not process entries with nextAttemptAt in the future', async () => {
      dispatcher.fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });

      const id = await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: {},
      });

      // Push the next attempt into the future
      const row = db._store.get(id)!;
      row.nextAttemptAt = Date.now() + 60_000;

      const processed = await dispatcher.processPending();
      expect(processed).toBe(0);
      expect(dispatcher.fetchFn).not.toHaveBeenCalled();
    });

    it('processes multiple pending callbacks', async () => {
      dispatcher.fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });

      await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook1',
        eventType: 'turn.completed',
        payload: { id: 1 },
      });

      await dispatcher.enqueue({
        agentId: 'agent-2',
        callbackUrl: 'https://example.com/hook2',
        eventType: 'turn.completed',
        payload: { id: 2 },
      });

      const processed = await dispatcher.processPending();
      expect(processed).toBe(2);
      expect(db.markCallbackDelivered).toHaveBeenCalledTimes(2);
    });
  });

  describe('start/stop', () => {
    it('starts and stops the polling loop without error', () => {
      dispatcher.start();
      // Starting again should be a no-op
      dispatcher.start();
      dispatcher.stop();
      // Stopping again should be a no-op
      dispatcher.stop();
    });

    it('does not throw when stop is called before start', () => {
      expect(() => dispatcher.stop()).not.toThrow();
    });
  });

  describe('concurrent processing', () => {
    it('handles mixed success and failure in one batch', async () => {
      let callCount = 0;
      dispatcher.fetchFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { ok: true, status: 200, statusText: 'OK' };
        }
        return { ok: false, status: 500, statusText: 'Internal Server Error' };
      });

      await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook1',
        eventType: 'turn.completed',
        payload: {},
      });

      await dispatcher.enqueue({
        agentId: 'agent-2',
        callbackUrl: 'https://example.com/hook2',
        eventType: 'turn.completed',
        payload: {},
      });

      const processed = await dispatcher.processPending();
      expect(processed).toBe(2);
      expect(db.markCallbackDelivered).toHaveBeenCalledTimes(1);
      expect(db.markCallbackFailed).toHaveBeenCalledTimes(1);
    });
  });
});
