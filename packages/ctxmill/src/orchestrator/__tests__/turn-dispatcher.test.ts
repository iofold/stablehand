import { describe, expect, it, vi } from 'vitest';

import { TurnDispatcher, type DispatchCandidate, type TurnDispatcherDeps } from '../turn-dispatcher.js';

function candidate(overrides: Partial<DispatchCandidate>): DispatchCandidate {
  return {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    startedAt: 1_000,
    sessionStatus: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<TurnDispatcherDeps> = {}): TurnDispatcherDeps & {
  dispatched: DispatchCandidate[];
  expired: string[];
} {
  const dispatched: DispatchCandidate[] = [];
  const expired: string[] = [];
  return {
    dispatched,
    expired,
    db: {
      getDispatchableQueuedTurns: async () => [],
      getExpiredQueuedTurns: async () => [],
    },
    dispatchTurn: async (c) => {
      dispatched.push(c);
      return 'dispatched';
    },
    expireTurn: async (t) => {
      expired.push(t.turnId);
    },
    hasSlotHeadroom: () => true,
    queuedTurnTimeoutMs: async () => 1_800_000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe('TurnDispatcher (ctx-z5k0)', () => {
  it('dispatches warm candidates even with zero slot headroom', async () => {
    const batches = [
      [
        candidate({ turnId: 'cold-1', sessionStatus: null, startedAt: 1 }),
        candidate({ turnId: 'warm-1', conversationId: 'conv-2', sessionStatus: 'ACTIVE', startedAt: 2 }),
      ],
      [],
    ];
    const deps = makeDeps({
      db: {
        getDispatchableQueuedTurns: async () => batches.shift() ?? [],
        getExpiredQueuedTurns: async () => [],
      },
      hasSlotHeadroom: () => false,
    });
    await new TurnDispatcher(deps).runPass();
    expect(deps.dispatched.map((c) => c.turnId)).toEqual(['warm-1']);
  });

  it('treats RESTORING sessions as slot-lane, not warm', async () => {
    const batches = [[candidate({ turnId: 'restoring-1', sessionStatus: 'RESTORING' })], []];
    const deps = makeDeps({
      db: {
        getDispatchableQueuedTurns: async () => batches.shift() ?? [],
        getExpiredQueuedTurns: async () => [],
      },
      hasSlotHeadroom: () => false,
    });
    await new TurnDispatcher(deps).runPass();
    expect(deps.dispatched).toEqual([]);
  });

  it('serves the least-recently-served agent first even against older turns', async () => {
    // agent-a has the older turn both times; after a is served once, b must
    // lead the second batch despite a's older startedAt.
    const batches = [
      [
        candidate({ turnId: 'a-1', agentId: 'agent-a', conversationId: 'conv-a', startedAt: 1 }),
      ],
      [
        candidate({ turnId: 'a-2', agentId: 'agent-a', conversationId: 'conv-a', startedAt: 2 }),
        candidate({ turnId: 'b-1', agentId: 'agent-b', conversationId: 'conv-b', startedAt: 5 }),
      ],
      [],
      [],
    ];
    const deps = makeDeps({
      db: {
        getDispatchableQueuedTurns: async () => batches.shift() ?? [],
        getExpiredQueuedTurns: async () => [],
      },
    });
    await new TurnDispatcher(deps).runPass();
    const order = deps.dispatched.map((c) => c.turnId);
    expect(order[0]).toBe('a-1');
    expect(order.indexOf('b-1')).toBeLessThan(order.indexOf('a-2'));
  });

  it('expires stale queued turns before dispatching', async () => {
    const deps = makeDeps({
      db: {
        getDispatchableQueuedTurns: async () => [],
        getExpiredQueuedTurns: async (cutoff) => (cutoff > 0 ? [{ turnId: 'old-1', agentId: 'a', conversationId: null }] : []),
      },
    });
    await new TurnDispatcher(deps).runPass();
    expect(deps.expired).toEqual(['old-1']);
  });

  it('is single-flight and coalesces kicks into the running pass', async () => {
    let resolveBatch: (() => void) | undefined;
    let batchCalls = 0;
    const deps = makeDeps({
      db: {
        getDispatchableQueuedTurns: async () => {
          batchCalls += 1;
          if (batchCalls === 1) {
            await new Promise<void>((resolve) => { resolveBatch = resolve; });
          }
          return [];
        },
        getExpiredQueuedTurns: async () => [],
      },
    });
    const dispatcher = new TurnDispatcher(deps);
    const first = dispatcher.runPass();
    while (!resolveBatch) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const second = dispatcher.runPass(); // coalesces, does not run concurrently
    resolveBatch();
    await Promise.all([first, second]);
    // first pass + the coalesced kick loop = 2 batch reads, never interleaved
    expect(batchCalls).toBe(2);
  });

  it('reports stalled when no pass has completed recently', async () => {
    let nowMs = 100_000;
    const deps = makeDeps({ now: () => nowMs });
    const dispatcher = new TurnDispatcher(deps);
    await dispatcher.runPass();
    expect(dispatcher.isStalled()).toBe(false);
    nowMs += 31_000;
    expect(dispatcher.isStalled()).toBe(true);
  });

  it('a dispatch error skips the candidate without killing the pass', async () => {
    const batches = [
      [candidate({ turnId: 'bad-1', startedAt: 1 }), candidate({ turnId: 'good-1', conversationId: 'conv-2', startedAt: 2 })],
      [],
    ];
    const deps = makeDeps({
      db: {
        getDispatchableQueuedTurns: async () => batches.shift() ?? [],
        getExpiredQueuedTurns: async () => [],
      },
    });
    const original = deps.dispatchTurn;
    deps.dispatchTurn = async (c) => {
      if (c.turnId === 'bad-1') throw new Error('boom');
      return original(c);
    };
    await new TurnDispatcher(deps).runPass();
    expect(deps.dispatched.map((c) => c.turnId)).toEqual(['good-1']);
  });
});
