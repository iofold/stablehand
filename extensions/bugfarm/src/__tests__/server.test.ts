import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangeHub } from '../hub.js';
import { createBugfarmServer } from '../server.js';
import type { BoardRow } from '../shared/board.js';
import type { BoardStore } from '../store/store.js';
import { disposeStore, freshStore } from './test-db.js';

const INGEST = 'ingest-token-for-tests';
const SECRET = 'webhook-secret-for-tests';

/** Minimal SSE reader: collects `event`/`data` frames from a fetch body. */
async function readEvents(url: string, until: (events: { event: string; data: string; id?: string }[]) => boolean, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal, headers });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: string; id?: string }[] = [];
  let buffer = '';
  const deadline = Date.now() + 5000;
  while (!until(events) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event: { event: string; data: string; id?: string } = { event: 'message', data: '' };
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event.event = line.slice(7);
        else if (line.startsWith('data: ')) event.data += line.slice(6);
        else if (line.startsWith('id: ')) event.id = line.slice(4);
      }
      if (event.data) events.push(event);
    }
  }
  controller.abort();
  return events;
}

describe('Bugfarm worker HTTP API', () => {
  let store: BoardStore;
  let hub: ChangeHub;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    store = await freshStore();
    hub = new ChangeHub(store);
    await hub.start();
    server = createBugfarmServer({
      store,
      hub,
      ingestToken: INGEST,
      viewToken: '',
      webhookSecret: SECRET,
      campaignKey: 'main',
      webDir: null,
      link: () => null,
      sim: () => null,
      heartbeatMs: 60_000,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeStore(store);
  });

  const ingest = (rows: unknown, token = INGEST) => fetch(`${base}/internal/v1/rows`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });

  it('reports health', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: true, ingest: 'on' });
  });

  it('refuses ingest without the token and explains invalid rows', async () => {
    expect((await ingest([{ kind: 'batch', key: '1', payload: { n: 1 } }], 'nope')).status).toBe(401);
    const bad = await ingest([{ kind: 'item', key: 'x', payload: { stage: 'nowhere' } }]);
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/stage/);
    const malformed = await ingest([{ kind: 'unknown', key: 'x', payload: {} }]);
    expect(malformed.status).toBe(400);
  });

  it('ingests rows and serves them from state and changes', async () => {
    const res = await ingest([
      { kind: 'campaign', key: 'main', payload: { cap_usd: 500, spend_usd: 12.5 } },
      { kind: 'item', key: 'pyline@abc', payload: { stage: 'mined', title: 'Fix wrap', repo: 'o/p', sha: 'abc' } },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json() as { cursor: number; results: { changed: boolean }[] };
    expect(body.results.every((entry) => entry.changed)).toBe(true);

    const state = await (await fetch(`${base}/api/state`)).json() as { rows: BoardRow[]; cursor: number; epoch: string };
    expect(state.cursor).toBe(body.cursor);
    expect(state.rows.map((row) => row.key).sort()).toEqual(['main', 'pyline@abc']);

    const changes = await (await fetch(`${base}/api/changes?since=0&limit=1`)).json() as { rows: BoardRow[]; more: boolean };
    expect(changes.rows).toHaveLength(1);
    expect(changes.more).toBe(true);

    const single = await fetch(`${base}/internal/v1/rows/item/${encodeURIComponent('pyline@abc')}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${INGEST}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'env_ready' }),
    });
    expect(single.status).toBe(200);
    const after = await (await fetch(`${base}/api/changes?since=${body.cursor}`)).json() as { rows: BoardRow[] };
    expect(after.rows[0].payload).toMatchObject({ stage: 'env_ready', title: 'Fix wrap' });
  });

  it('streams backlog then live changes over SSE', async () => {
    const cursor = (await (await fetch(`${base}/api/state`)).json() as { cursor: number }).cursor;
    const reading = readEvents(`${base}/api/stream?since=${cursor - 1}`, (events) => events.filter((e) => e.event === 'change').length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await ingest([{ kind: 'item', key: 'pyline@abc', payload: { stage: 'fail_pass' } }]);
    const events = await reading;
    expect(events[0].event).toBe('hello');
    const changes = events.filter((e) => e.event === 'change').map((e) => JSON.parse(e.data) as BoardRow);
    expect(changes[0].id).toBe(cursor);
    expect(changes[1].payload).toMatchObject({ stage: 'fail_pass' });
    expect(changes[1].id).toBeGreaterThan(changes[0].id);
  });

  it('resumes from Last-Event-ID and tells clients from an old epoch to reload', async () => {
    const state = await (await fetch(`${base}/api/state`)).json() as { cursor: number; epoch: string };
    const resumed = await readEvents(`${base}/api/stream?since=0`, (events) => events.some((e) => e.event === 'change'), { 'Last-Event-ID': String(state.cursor - 1) });
    const first = resumed.find((e) => e.event === 'change');
    expect(Number(first?.id)).toBe(state.cursor);

    const stale = await readEvents(`${base}/api/stream?epoch=not-current`, (events) => events.some((e) => e.event === 'reset'));
    expect(stale.some((e) => e.event === 'reset')).toBe(true);
  });

  it('verifies webhook signatures and records the approval', async () => {
    const body = JSON.stringify({ agentId: 'agent-pub', interruptId: 'int-1', toolName: 'request-approval', turnId: 't', conversationId: 'c', toolCallId: 'tc', args: {}, timestamp: 1234 });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'X-Event-Type': 'interrupt.requested',
      'X-Agent-Id': 'agent-pub',
      'X-Delivery-Id': 'd-1',
      'X-Webhook-Timestamp': ts,
      'X-Webhook-Signature': `v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`,
    };
    const forged = await fetch(`${base}/hooks/stablehand`, { method: 'POST', headers: { ...headers, 'X-Webhook-Signature': `v1=${'0'.repeat(64)}` }, body });
    expect(forged.status).toBe(401);

    const ok = await fetch(`${base}/hooks/stablehand`, { method: 'POST', headers, body });
    expect(ok.status).toBe(200);
    const again = await fetch(`${base}/hooks/stablehand`, { method: 'POST', headers, body });
    expect(await again.json()).toMatchObject({ duplicate: true });

    const campaign = await store.latest('campaign', 'main');
    expect(campaign?.payload).toMatchObject({ cap_usd: 500, approval: { state: 'waiting', interrupt_id: 'int-1' } });
  });

  it('clears the board only with explicit confirmation', async () => {
    const refuse = await fetch(`${base}/internal/v1/reset`, { method: 'POST', headers: { Authorization: `Bearer ${INGEST}` }, body: '{}' });
    expect(refuse.status).toBe(400);
    const before = await (await fetch(`${base}/api/state`)).json() as { epoch: string };
    const reset = await fetch(`${base}/internal/v1/reset`, { method: 'POST', headers: { Authorization: `Bearer ${INGEST}` }, body: JSON.stringify({ confirm: 'erase-board' }) });
    expect(reset.status).toBe(200);
    const after = await (await fetch(`${base}/api/state`)).json() as { epoch: string; rows: BoardRow[] };
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.rows).toEqual([]);
  });
});

describe('view token', () => {
  let store: BoardStore;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    store = await freshStore();
    const hub = new ChangeHub(store);
    await hub.start();
    server = createBugfarmServer({
      store, hub, ingestToken: INGEST, viewToken: 'peek', webhookSecret: SECRET, campaignKey: 'main', webDir: null, link: () => null, sim: () => null,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeStore(store);
  });

  it('keeps the board private until the key is presented once', async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    const login = await fetch(`${base}/?key=peek`, { redirect: 'manual' });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await fetch(`${base}/api/state`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
