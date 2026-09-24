import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CallbackDispatcher } from '../callback-dispatcher.js';
import type { CallbackOutboxRow, DatabaseRepository } from '../../database/repository.js';

/**
 * Repro for ctx-4p34 defects (b) and (c). These tests assert the invariants a
 * fix must satisfy, so they are RED at HEAD and turn green when the defect is
 * repaired — they are not documentation of current behavior.
 *
 * Defect (a) — the duplicate-delivery window — needs the real claim SQL and
 * lives in tests/integration/callback-dispatcher-duplicate-delivery.repro.test.ts.
 */

const CLAIM_LEASE_MS = 60_000; // mirrors DEFAULT_CLAIM_LEASE_MS in repository.ts

/**
 * Mock repository that models the claim lease the way repository.ts does:
 * a claim flips the row to in_progress and stamps claimedAt/claimExpiresAt,
 * and only pending rows (or in_progress rows whose lease has lapsed) are
 * claimable. The mock in callback-dispatcher.test.ts predates the lease and
 * hands the same row back on every scan, which hides the overlap.
 */
function createLeaseAwareMockDb() {
  const store = new Map<string, CallbackOutboxRow>();

  const db = {
    enqueueCallback: vi.fn(async (data: CallbackOutboxRow) => {
      const row = { ...data };
      store.set(row.id, row);
      return row;
    }),
    claimPendingCallbacks: vi.fn(async (limit: number, beforeTime: number) => {
      const now = Date.now();
      const claimed: CallbackOutboxRow[] = [];
      for (const row of store.values()) {
        if (row.nextAttemptAt > beforeTime) continue;
        const claimable = row.status === 'pending'
          || (row.status === 'in_progress' && (row.claimExpiresAt ?? 0) < now);
        if (!claimable) continue;
        row.status = 'in_progress';
        row.claimedAt = now;
        row.claimExpiresAt = now + CLAIM_LEASE_MS;
        claimed.push({ ...row });
        if (claimed.length >= limit) break;
      }
      return claimed;
    }),
    markCallbackDelivered: vi.fn(async (id: string, claimedAt?: number | null) => {
      const row = store.get(id);
      if (!row || row.status !== 'in_progress') return;
      if (claimedAt != null && row.claimedAt !== claimedAt) return; // stale claim
      row.status = 'delivered';
      row.deliveredAt = Date.now();
      row.claimedAt = null;
      row.claimExpiresAt = null;
    }),
    markCallbackFailed: vi.fn(async (
      id: string,
      error: string,
      nextAttemptAt?: number,
      claimedAt?: number | null,
    ) => {
      const row = store.get(id);
      if (!row) return;
      if (claimedAt != null && row.claimedAt !== claimedAt) return; // stale claim
      row.attempts += 1;
      row.lastAttemptAt = Date.now();
      row.lastError = error;
      row.status = row.attempts >= row.maxAttempts ? 'failed' : 'pending';
      if (row.status === 'pending') row.nextAttemptAt = nextAttemptAt ?? Date.now();
      row.claimedAt = null;
      row.claimExpiresAt = null;
    }),
    renewCallbackClaim: vi.fn(async (id: string, claimedAt: number, leaseMs: number) => {
      const row = store.get(id);
      if (!row || row.status !== 'in_progress' || row.claimedAt !== claimedAt) return false;
      row.claimExpiresAt = Date.now() + leaseMs;
      return true;
    }),
    getWebhookForAgent: vi.fn(async () => undefined),
    _store: store,
  };

  return db as unknown as DatabaseRepository & { _store: Map<string, CallbackOutboxRow> };
}

describe('ctx-4p34 callback dispatcher repro', () => {
  let db: ReturnType<typeof createLeaseAwareMockDb>;

  beforeEach(() => {
    db = createLeaseAwareMockDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('(b) single-flight', () => {
    it('does not start a second poll pass while one is still in flight', async () => {
      vi.useFakeTimers();
      const pollIntervalMs = 100;
      const dispatcher = new CallbackDispatcher(db, pollIntervalMs);

      let releaseDelivery!: () => void;
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      let deliveriesEntered = 0;
      dispatcher.fetchFn = vi.fn(async () => {
        deliveriesEntered++;
        await deliveryGate;
        return { ok: true, status: 200, statusText: 'OK' } as Response;
      });

      await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/slow',
        eventType: 'turn.completed',
        payload: {},
      });

      dispatcher.start();

      // Tick 1 claims the row and blocks inside the HTTP call, exactly as a
      // real endpoint sitting on the 10s delivery timeout would.
      await vi.advanceTimersByTimeAsync(pollIntervalMs);
      expect(deliveriesEntered).toBe(1);

      // Three more poll intervals elapse while that pass is still running.
      await vi.advanceTimersByTimeAsync(pollIntervalMs * 3);

      // TurnDispatcher.runPass() guards re-entry with `passActive`; this loop
      // sets `this.running` and never reads it, so every tick starts a fresh
      // overlapping pass. Overlap is what lets an expired claim be re-scanned
      // by the same process, which is the engine behind defect (a).
      expect(
        vi.mocked(db.claimPendingCallbacks).mock.calls.length,
        'poll ticks must not overlap: a pass was still in flight',
      ).toBe(1);

      releaseDelivery();
      await vi.advanceTimersByTimeAsync(0);
      dispatcher.stop();
    });
  });

  describe('(c) dead-letter visibility', () => {
    it('surfaces a permanently failed delivery to operators', async () => {
      const dispatcher = new CallbackDispatcher(db, 1000);
      dispatcher.fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const id = await dispatcher.enqueue({
        agentId: 'agent-1',
        callbackUrl: 'https://example.com/hook',
        eventType: 'turn.completed',
        payload: {},
      });
      // One attempt short of maxAttempts: the next failure is terminal.
      db._store.get(id)!.attempts = 4;

      // Accept either shape a minimal fix might take — an operator log line or
      // a dead-letter hook — so this stays red only while the failure is silent.
      const deadLetterHookCalls: string[] = [];
      (dispatcher as unknown as { onDeadLetter?: (row: CallbackOutboxRow) => void })
        .onDeadLetter = (row) => deadLetterHookCalls.push(row.id);

      const logged: string[] = [];
      const capture = (...args: unknown[]) => logged.push(args.map(String).join(' '));
      const originalError = console.error;
      const originalWarn = console.warn;
      console.error = capture;
      console.warn = capture;
      try {
        await dispatcher.processPending();
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
      }

      expect(db._store.get(id)!.status).toBe('failed');
      expect(
        [...deadLetterHookCalls, ...logged.filter((line) => line.includes(id))],
        'a dead-lettered callback must emit some operator-visible signal',
      ).not.toHaveLength(0);
    });
  });
});
