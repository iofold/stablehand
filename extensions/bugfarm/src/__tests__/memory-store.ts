import type { BoardRow, RowKind } from '../shared/board.js';
import { mergePayload } from '../store/payload.js';
import type { UpsertInput } from '../store/validate.js';

/** The board store's write and read semantics (merge by default, latest row wins), in memory. */
export class MemoryStore {
  private nextId = 1;
  readonly history: BoardRow[] = [];
  private readonly latestRows = new Map<string, BoardRow>();

  async upsert(rows: UpsertInput[]): Promise<{ rows: BoardRow[] }> {
    const written: BoardRow[] = [];
    for (const input of rows) {
      const id = `${input.kind}\u0000${input.key}`;
      const previous = this.latestRows.get(id);
      const payload = input.mode === 'replace' || !previous
        ? input.payload
        : mergePayload(previous.payload as Record<string, unknown>, input.payload);
      const row = { id: this.nextId++, kind: input.kind, key: input.key, content_sha: '', payload, created_at: Date.now() } as BoardRow;
      this.latestRows.set(id, row);
      this.history.push(row);
      written.push(row);
    }
    return { rows: written };
  }

  async latest(kind: RowKind, key: string): Promise<BoardRow | null> {
    return this.latestRows.get(`${kind}\u0000${key}`) ?? null;
  }

  async currentOfKind<K extends RowKind>(kind: K): Promise<BoardRow<K>[]> {
    return [...this.latestRows.values()].filter((row) => row.kind === kind).sort((a, b) => a.id - b.id) as BoardRow<K>[];
  }

  payload<T = Record<string, unknown>>(kind: RowKind, key: string): T | null {
    return (this.latestRows.get(`${kind}\u0000${key}`)?.payload as T | undefined) ?? null;
  }
}
