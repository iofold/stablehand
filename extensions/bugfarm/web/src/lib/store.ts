import { create } from 'zustand';
import type { BoardRow, StateResponse } from '../../../src/shared/board';

/**
 * The board's copy of the store: the latest row per (kind, key), loaded once
 * from /api/state and then kept current by /api/stream. Incoming rows are
 * buffered and applied once per animation frame, so a burst of writes costs
 * one render.
 */

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';

interface BoardState {
  epoch: string;
  cursor: number;
  rows: Map<string, BoardRow>;
  /** When each (kind, key) first appeared in this browser; drives the pop-in. */
  firstSeen: Map<string, number>;
  loadedAt: number;
  connection: Connection;
  version: number;
  error: string | null;
}

export const useBoard = create<BoardState>(() => ({
  epoch: '',
  cursor: 0,
  rows: new Map(),
  firstSeen: new Map(),
  loadedAt: 0,
  connection: 'connecting',
  version: 0,
  error: null,
}));

export const rowId = (row: Pick<BoardRow, 'kind' | 'key'>) => `${row.kind}:${row.key}`;

let source: EventSource | null = null;
let pending: BoardRow[] = [];
let frame: number | null = null;

function flush(): void {
  frame = null;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  useBoard.setState((state) => {
    const rows = new Map(state.rows);
    const firstSeen = new Map(state.firstSeen);
    let cursor = state.cursor;
    const now = performance.now();
    for (const row of batch) {
      if (row.id <= cursor && rows.get(rowId(row))?.id === row.id) continue;
      const id = rowId(row);
      const existing = rows.get(id);
      if (!existing || existing.id < row.id) rows.set(id, row);
      if (!firstSeen.has(id)) firstSeen.set(id, now);
      cursor = Math.max(cursor, row.id);
    }
    return { rows, firstSeen, cursor, version: state.version + 1 };
  });
}

function enqueue(row: BoardRow): void {
  pending.push(row);
  if (frame === null) frame = requestAnimationFrame(flush);
}

async function loadState(): Promise<void> {
  const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 401 ? 'This board is private. Open it with its view link.' : `The board API answered ${res.status}.`);
  const state = (await res.json()) as StateResponse;
  const rows = new Map<string, BoardRow>();
  const firstSeen = new Map<string, number>();
  for (const row of state.rows) {
    rows.set(rowId(row), row);
    firstSeen.set(rowId(row), 0);
  }
  useBoard.setState((prev) => ({
    epoch: state.epoch,
    cursor: state.cursor,
    rows,
    firstSeen,
    loadedAt: performance.now(),
    version: prev.version + 1,
    error: null,
  }));
}

function openStream(): void {
  source?.close();
  const { cursor, epoch } = useBoard.getState();
  const stream = new EventSource(`/api/stream?since=${cursor}&epoch=${encodeURIComponent(epoch)}`);
  source = stream;
  stream.addEventListener('hello', () => useBoard.setState({ connection: 'live' }));
  stream.addEventListener('change', (event) => {
    enqueue(JSON.parse((event as MessageEvent<string>).data) as BoardRow);
  });
  stream.addEventListener('reset', () => {
    void restart();
  });
  stream.onerror = () => {
    if (source !== stream) return;
    useBoard.setState({ connection: stream.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting' });
    if (stream.readyState === EventSource.CLOSED) setTimeout(() => void restart(), 3000);
  };
}

async function restart(): Promise<void> {
  source?.close();
  source = null;
  pending = [];
  useBoard.setState({ connection: 'connecting' });
  try {
    await loadState();
    openStream();
  } catch (err) {
    useBoard.setState({ connection: 'offline', error: (err as Error).message });
    setTimeout(() => void restart(), 4000);
  }
}

export function connectBoard(): () => void {
  void restart();
  return () => {
    source?.close();
    source = null;
  };
}
