import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentSha, mergePayload, stableStringify } from '../store/payload.js';
import { BoardStore, UpsertValidationError, normalizePayload } from '../store/store.js';
import { disposeStore, freshStore } from './test-db.js';

describe('payload helpers', () => {
  it('merges plain objects deeply and replaces arrays and scalars', () => {
    const merged = mergePayload(
      { stage: 'mined', stage_times: { mined: 1 }, failing_tests: ['a', 'b'], difficulty: { openai: { passes: 0, attempts: 2 } } },
      { stage: 'env_ready', stage_times: { env_ready: 2 }, failing_tests: ['c'], difficulty: { anthropic: { passes: 1, attempts: 2 } } },
    );
    expect(merged).toEqual({
      stage: 'env_ready',
      stage_times: { mined: 1, env_ready: 2 },
      failing_tests: ['c'],
      difficulty: { openai: { passes: 0, attempts: 2 }, anthropic: { passes: 1, attempts: 2 } },
    });
  });

  it('hashes equal payloads equally regardless of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
    expect(contentSha({ a: 1, b: 2 })).toBe(contentSha({ b: 2, a: 1 }));
    expect(contentSha({ a: 1 })).not.toBe(contentSha({ a: 2 }));
  });

  it('stamps the entry time of a stage the item has not been in before', () => {
    expect(normalizePayload('item', { stage: 'controls', stage_times: { mined: 5 } }, 99)).toEqual({
      stage: 'controls',
      stage_times: { mined: 5, controls: 99 },
    });
    expect(normalizePayload('item', { stage: 'controls', stage_times: { controls: 7 } }, 99)).toEqual({
      stage: 'controls',
      stage_times: { controls: 7 },
    });
    expect(normalizePayload('batch', { n: 1 }, 99)).toEqual({ n: 1 });
  });
});

describe('BoardStore (Postgres)', () => {
  let store: BoardStore;

  beforeAll(async () => {
    store = await freshStore();
  });

  afterAll(async () => {
    await disposeStore(store);
  });

  it('appends rows, skips unchanged payloads and keeps the latest per (kind, key)', async () => {
    const first = await store.upsert([
      { kind: 'item', key: 'demo@aaa', payload: { stage: 'mined', title: 'Fix wrap', repo: 'o/p' } },
    ], 1_000);
    expect(first.results).toEqual([{ kind: 'item', key: 'demo@aaa', id: expect.any(Number), changed: true }]);
    expect(first.rows[0].payload).toMatchObject({ stage: 'mined', stage_times: { mined: 1_000 } });

    const same = await store.upsert([{ kind: 'item', key: 'demo@aaa', payload: { stage: 'mined' } }], 2_000);
    expect(same.results[0]).toMatchObject({ changed: false, id: null });

    const moved = await store.upsert([{ kind: 'item', key: 'demo@aaa', payload: { stage: 'env_ready' } }], 3_000);
    expect(moved.results[0].changed).toBe(true);
    expect(moved.rows[0].payload).toMatchObject({
      stage: 'env_ready',
      title: 'Fix wrap',
      stage_times: { mined: 1_000, env_ready: 3_000 },
    });

    const latest = await store.latest('item', 'demo@aaa');
    expect(latest?.id).toBe(moved.rows[0].id);
    const current = await store.current();
    expect(current.rows.filter((row) => row.key === 'demo@aaa')).toHaveLength(1);
    expect(current.cursor).toBe(moved.cursor);
    expect(current.epoch).toMatch(/[0-9a-f-]{36}/);
  });

  it('replace mode writes the payload as given', async () => {
    await store.upsert([{ kind: 'cell', key: 'h:m', payload: { harness: 'h', model: 'm', solved: 1, attempts: 2, pass_at_1: 0.5, ci_low: 0.1 } }]);
    const replaced = await store.upsert([{ kind: 'cell', key: 'h:m', mode: 'replace', payload: { harness: 'h', model: 'm', solved: 2, attempts: 4, pass_at_1: 0.5 } }]);
    expect(replaced.rows[0].payload).not.toHaveProperty('ci_low');
  });

  it('rejects an invalid row and writes nothing from that call', async () => {
    const before = await store.cursor();
    await expect(store.upsert([
      { kind: 'batch', key: '9', payload: { n: 9, accepted: 1 } },
      { kind: 'item', key: 'bad', payload: { stage: 'teleported' } },
    ])).rejects.toBeInstanceOf(UpsertValidationError);
    expect(await store.cursor()).toBe(before);
    expect(await store.latest('batch', '9')).toBeNull();
  });

  it('later rows in one call build on earlier ones for the same key', async () => {
    const result = await store.upsert([
      { kind: 'item', key: 'demo@bbb', payload: { stage: 'mined', title: 'One' } },
      { kind: 'item', key: 'demo@bbb', payload: { stage: 'env_ready' } },
    ], 10);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].payload).toMatchObject({ title: 'One', stage: 'env_ready', stage_times: { mined: 10, env_ready: 10 } });
  });

  it('pages changes after a cursor in id order', async () => {
    const start = await store.cursor();
    for (let i = 0; i < 5; i += 1) {
      await store.upsert([{ kind: 'attempt', key: `a${i}`, payload: { item: 'demo@aaa', harness: 'h', model: 'm', try: i + 1, result: 'fail' } }]);
    }
    const page1 = await store.changes(start, 3);
    expect(page1.rows.map((row) => row.key)).toEqual(['a0', 'a1', 'a2']);
    expect(page1.more).toBe(true);
    const page2 = await store.changes(page1.cursor, 3);
    expect(page2.rows.map((row) => row.key)).toEqual(['a3', 'a4']);
    expect(page2.more).toBe(false);
    const empty = await store.changes(page2.cursor);
    expect(empty).toEqual({ rows: [], cursor: page2.cursor, more: false });
  });

  it('keeps ids in commit order under concurrent writers', async () => {
    const start = await store.cursor();
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.upsert([
      { kind: 'attempt', key: `c${i}`, payload: { item: 'x', harness: 'h', model: 'm', try: 1, result: 'pass' } },
    ])));
    const { rows } = await store.changes(start);
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(rows.map((row) => row.key)).size).toBe(12);
  });

  it('notifies listeners on commit', async () => {
    const signals: string[] = [];
    const stop = await store.listen((signal) => signals.push(signal));
    const written = await store.upsert([{ kind: 'rule', key: 'r1', payload: { text: 'Skip lockfile-only commits', batch_introduced: 1 } }]);
    await expect.poll(() => signals.length, { timeout: 3000 }).toBeGreaterThan(0);
    expect(signals).toContain(String(written.cursor));
    await stop();
  });

  it('reset of simulated rows leaves real rows and moves the epoch', async () => {
    await store.upsert([
      { kind: 'campaign', key: 'sim', payload: { cap_usd: 500, simulated: true } },
      { kind: 'campaign', key: 'real', payload: { cap_usd: 300 } },
    ]);
    const epochBefore = await store.epoch();
    const cursorBefore = await store.cursor();
    const summaryBefore = await store.summary();
    expect(summaryBefore.simulatedKeys).toBe(1);

    const result = await store.reset('simulated');
    expect(result.epoch).not.toBe(epochBefore);
    expect(await store.latest('campaign', 'sim')).toBeNull();
    expect(await store.latest('campaign', 'real')).not.toBeNull();

    const next = await store.upsert([{ kind: 'campaign', key: 'real', payload: { cap_usd: 301 } }]);
    expect(next.rows[0].id).toBeGreaterThan(cursorBefore);

    await store.reset('all');
    expect((await store.current()).rows).toEqual([]);
  });
});
