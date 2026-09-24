import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CallbackDispatcher } from '../../packages/stablehand/src/orchestrator/callback-dispatcher.js';
import { createTestDb, type TestDb } from '../utils/test-db.js';

/**
 * Repro for ctx-4p34 defect (a): the duplicate-delivery window.
 *
 * claimPendingCallbacks stamps a 60s lease (DEFAULT_CLAIM_LEASE_MS,
 * repository.ts:103) on a batch of up to 50 rows, and processPending delivers
 * that batch sequentially with a 10s HTTP timeout per row
 * (callback-dispatcher.ts:110,113-116,153). Seven slow endpoints are enough to
 * outlive the lease with rows still undelivered, at which point any other
 * scanner — a second orchestrator replica, or this process's own next tick,
 * since there is no single-flight guard — re-claims those rows and POSTs them
 * again while the first request is still in flight.
 *
 * The test forces that window with the real claim SQL: it expires the live
 * claim exactly the way the delivery-fence integration test expires a turn
 * lease, rather than waiting 500 seconds.
 *
 * It expires the leases of the rows the dispatcher has NOT yet started
 * (hook-1, hook-2) — the faithful failure mode: per-row renewal keeps the
 * actively-delivering row's lease fresh for its <=10s POST, so only un-started
 * batch rows go stale. RED at HEAD (A re-POSTs hook-1/hook-2 after B already
 * delivered them, because A never re-checks ownership), green once deliver()
 * renews the claim per row and skips rows a re-claimer has taken. Asserting on
 * POSTs is deliberate: the claimedAt guards keep the DB rows correct, so the
 * only evidence of the bug is the extra webhook that already left the process.
 */

describe('ctx-4p34 callback outbox duplicate delivery', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb?.close();
  });

  it('delivers each outbox row exactly once when a claim lapses mid-batch', async () => {
    const agent = await testDb.repo.createAgent({
      name: 'Outbox Duplicate Agent',
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
      systemPrompt: 'Test callback outbox claim leases.',
      tools: [],
    });

    /** Every POST the orchestrator makes, by X-Delivery-Id. */
    const posted: string[] = [];
    const recordPost = (init: RequestInit): void => {
      const headers = init.headers as Record<string, string>;
      posted.push(headers['X-Delivery-Id']);
    };

    let releaseSlowEndpoint!: () => void;
    const slowEndpoint = new Promise<void>((resolve) => {
      releaseSlowEndpoint = resolve;
    });
    let slowEndpointEntered!: () => void;
    const enteredSlowEndpoint = new Promise<void>((resolve) => {
      slowEndpointEntered = resolve;
    });

    // Replica A: its first delivery hangs (a slow customer endpoint), the rest
    // return immediately. Batch order is unspecified (UPDATE...RETURNING), so
    // record WHICH row A is stalled inside.
    let callsOnA = 0;
    let stalledUrlOnA = '';
    const dispatcherA = new CallbackDispatcher(testDb.repo, 5_000, vi.fn(async (url, init) => {
      recordPost(init);
      if (++callsOnA === 1) {
        stalledUrlOnA = String(url);
        slowEndpointEntered();
        await slowEndpoint;
      }
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }));

    // Replica B: the second dispatcher instance (or, equivalently, A's own
    // next 5s tick — nothing stops either from scanning).
    const dispatcherB = new CallbackDispatcher(testDb.repo, 5_000, vi.fn(async (_url, init) => {
      recordPost(init);
      return { ok: true, status: 200, statusText: 'OK' } as Response;
    }));

    const deliveryIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      deliveryIds.push(await dispatcherA.enqueue({
        agentId: agent.id,
        callbackUrl: `https://example.com/hook-${i}`,
        eventType: 'turn.completed',
        eventSeq: i,
        payload: { index: i },
      }));
    }

    // A claims all three rows under one lease and stalls on the first.
    const passA = dispatcherA.processPending();
    await enteredSlowEndpoint;

    const claimed = await testDb.conn.pgClient<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM callback_outbox WHERE status = 'in_progress'
    `;
    expect(claimed[0].count).toBe(3);

    // The lease lapses for the rows A has not reached yet while it is stalled
    // inside one of them — the 60s lease against a batch that can legitimately
    // run ~500s. The in-flight row keeps the lease its per-row renewal just
    // gave it (POSTs are <=10s; a fresh 60s lease cannot expire under one) —
    // the mid-POST residual window is documented, not what this test pins.
    await testDb.conn.pgClient`
      UPDATE callback_outbox
      SET claim_expires_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1
      WHERE status = 'in_progress' AND callback_url <> ${stalledUrlOnA}
    `;

    // Any other scanner now re-claims rows whose HTTP requests A has either
    // in flight or still ahead of it.
    await dispatcherB.processPending();

    releaseSlowEndpoint();
    await passA;

    const postsPerDelivery = new Map<string, number>();
    for (const id of posted) {
      postsPerDelivery.set(id, (postsPerDelivery.get(id) ?? 0) + 1);
    }
    const duplicated = deliveryIds.filter((id) => (postsPerDelivery.get(id) ?? 0) > 1);

    expect(
      duplicated,
      `outbox rows POSTed more than once: ${JSON.stringify([...postsPerDelivery])}`,
    ).toEqual([]);
    // Count only this test's rows — under the full suite, leftover pending
    // outbox rows from earlier files are legitimately delivered by B too.
    const ownPosts = posted.filter((id) => deliveryIds.includes(id));
    expect(ownPosts).toHaveLength(deliveryIds.length);
  });
});
