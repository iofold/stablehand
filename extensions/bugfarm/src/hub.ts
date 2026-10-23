import type { BoardRow } from './shared/board.js';

/**
 * Fans board changes out to live subscribers (the SSE stream).
 *
 * Any write, from this process or another one sharing the database, calls
 * `poke()` (directly, or through Postgres NOTIFY). One pump at a time reads
 * the rows after the last broadcast id and hands each subscriber the ones it
 * has not seen. A new subscriber first replays its backlog from its own
 * cursor; rows broadcast meanwhile are queued and de-duplicated by id, so
 * every subscriber sees every row exactly once, in id order.
 */

export interface HubStore {
  changes(since: number, limit?: number): Promise<{ rows: BoardRow[]; cursor: number; more: boolean }>;
  cursor(): Promise<number>;
}

export interface HubSubscriber {
  sendRow(row: BoardRow): void;
  sendReset(epoch: string): void;
}

interface Logger {
  warn(message: string, ...args: unknown[]): void;
}

interface Entry {
  subscriber: HubSubscriber;
  sentId: number;
  ready: boolean;
  queue: BoardRow[];
}

export class ChangeHub {
  private readonly entries = new Set<Entry>();
  private lastId = 0;
  private pumping: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly store: HubStore,
    private readonly logger: Logger = console,
  ) {}

  async start(): Promise<void> {
    this.lastId = await this.store.cursor();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Something was written. Coalesces bursts into as few reads as possible. */
  poke(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async pump(): Promise<void> {
    do {
      this.again = false;
      try {
        let more = true;
        while (more) {
          const page = await this.store.changes(this.lastId, 500);
          more = page.more;
          for (const row of page.rows) this.broadcast(row);
          if (page.rows.length > 0) this.lastId = page.cursor;
        }
      } catch (err) {
        this.logger.warn('[bugfarm] change pump failed; the next write retries it', err);
        return;
      }
    } while (this.again);
  }

  private broadcast(row: BoardRow): void {
    for (const entry of this.entries) {
      if (!entry.ready) {
        entry.queue.push(row);
        continue;
      }
      if (row.id <= entry.sentId) continue;
      entry.subscriber.sendRow(row);
      entry.sentId = row.id;
    }
  }

  /** Tell every subscriber the board was cleared; they reload from scratch. */
  async reset(epoch: string): Promise<void> {
    this.lastId = await this.store.cursor();
    for (const entry of this.entries) {
      entry.queue = [];
      entry.sentId = this.lastId;
      entry.subscriber.sendReset(epoch);
    }
  }

  /** Replay rows after `since`, then stream live. Returns the unsubscribe function. */
  async subscribe(subscriber: HubSubscriber, since: number): Promise<() => void> {
    const entry: Entry = { subscriber, sentId: since, ready: false, queue: [] };
    this.entries.add(entry);
    const unsubscribe = () => {
      this.entries.delete(entry);
    };
    try {
      let more = true;
      while (more && this.entries.has(entry)) {
        const page = await this.store.changes(entry.sentId, 1000);
        more = page.more;
        for (const row of page.rows) {
          subscriber.sendRow(row);
          entry.sentId = row.id;
        }
      }
    } catch (err) {
      unsubscribe();
      throw err;
    }
    for (const row of entry.queue) {
      if (row.id > entry.sentId) {
        subscriber.sendRow(row);
        entry.sentId = row.id;
      }
    }
    entry.queue = [];
    entry.ready = true;
    return unsubscribe;
  }
}
