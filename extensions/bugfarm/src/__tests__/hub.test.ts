import { describe, expect, it } from 'vitest';
import { ChangeHub, type HubStore } from '../hub.js';
import type { BoardRow } from '../shared/board.js';

function row(id: number): BoardRow {
  return { id, kind: 'batch', key: String(id), content_sha: String(id), payload: { n: id }, created_at: id };
}

/** An in-memory store whose reads can be paused, to force overlaps. */
function memoryStore() {
  const rows: BoardRow[] = [];
  let gate: Promise<void> | null = null;
  const store: HubStore & { add(id: number): void; hold(): () => void } = {
    async changes(since, limit = 1000) {
      if (gate) await gate;
      const page = rows.filter((entry) => entry.id > since).slice(0, limit);
      return { rows: page, cursor: page.at(-1)?.id ?? since, more: rows.filter((entry) => entry.id > since).length > page.length };
    },
    async cursor() {
      return rows.at(-1)?.id ?? 0;
    },
    add(id) {
      rows.push(row(id));
    },
    hold() {
      let release: () => void = () => undefined;
      gate = new Promise((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
  return store;
}

function recorder() {
  const ids: number[] = [];
  const resets: string[] = [];
  return { ids, resets, subscriber: { sendRow: (entry: BoardRow) => ids.push(entry.id), sendReset: (epoch: string) => resets.push(epoch) } };
}

describe('ChangeHub', () => {
  it('replays the backlog, then streams live rows exactly once and in order', async () => {
    const store = memoryStore();
    for (let id = 1; id <= 3; id += 1) store.add(id);
    const hub = new ChangeHub(store);
    await hub.start();

    const early = recorder();
    await hub.subscribe(early.subscriber, 1);
    expect(early.ids).toEqual([2, 3]);

    // A subscriber joins while its backlog read is stalled and new rows land.
    const late = recorder();
    const release = store.hold();
    const joining = hub.subscribe(late.subscriber, 0);
    store.add(4);
    store.add(5);
    const pumping = hub.poke();
    release();
    await Promise.all([joining, pumping]);
    store.add(6);
    await hub.poke();

    expect(late.ids).toEqual([1, 2, 3, 4, 5, 6]);
    expect(early.ids).toEqual([2, 3, 4, 5, 6]);
  });

  it('stops sending after unsubscribe and sends each reset once', async () => {
    const store = memoryStore();
    const hub = new ChangeHub(store);
    await hub.start();
    const watcher = recorder();
    const unsubscribe = await hub.subscribe(watcher.subscriber, 0);

    await hub.reset('epoch-2');
    await hub.reset('epoch-2');
    expect(watcher.resets).toEqual(['epoch-2']);

    unsubscribe();
    store.add(1);
    await hub.poke();
    expect(watcher.ids).toEqual([]);
    expect(hub.size).toBe(0);
  });
});
