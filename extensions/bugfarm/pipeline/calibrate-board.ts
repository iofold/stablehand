// Writes calibration rows to the Bugfarm board through its ingest API (POST /internal/v1/rows).
// The board is a live view: a failed write never stops calibration. Rows that could not be sent
// wait in an outbox file next to the calibration records and go out on the next successful write,
// so the board catches up after an outage.
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { fileExists, log } from './lib/util.ts';

export interface BoardRow {
  kind: 'campaign' | 'batch' | 'item' | 'attempt' | 'rule' | 'cell';
  key: string;
  payload: Record<string, unknown>;
  mode?: 'merge' | 'replace';
}

export interface BoardSink {
  write(rows: BoardRow[]): Promise<void>;
}

export class NullBoard implements BoardSink {
  async write(_rows: BoardRow[]): Promise<void> {}
}

export class BoardClient implements BoardSink {
  private readonly url: string;
  private readonly token: string;
  private readonly outbox: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: { url: string; token: string; outbox: string }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.outbox = opts.outbox;
  }

  /** Writes are serialized so rows for one key land in the order they were produced. */
  write(rows: BoardRow[]): Promise<void> {
    this.chain = this.chain.then(() => this.send(rows));
    return this.chain;
  }

  private pending(): BoardRow[] {
    if (!fileExists(this.outbox)) return [];
    return readFileSync(this.outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as BoardRow);
  }

  private async post(rows: BoardRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 400) {
      const res = await fetch(`${this.url}/internal/v1/rows`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rows: rows.slice(i, i + 400) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`board ingest HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }

  private async send(rows: BoardRow[]): Promise<void> {
    const backlog = this.pending();
    try {
      if (backlog.length) {
        await this.post(backlog);
        rmSync(this.outbox, { force: true });
        log('board', `flushed ${backlog.length} queued rows`);
      }
      await this.post(rows);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A 422 means a row is invalid; queueing it would block the outbox forever.
      if (/HTTP 422/.test(msg)) {
        log('board', `rejected rows (not queued): ${msg}`);
        return;
      }
      log('board', `write failed, queued ${rows.length} rows: ${msg}`);
      for (const r of rows) appendFileSync(this.outbox, JSON.stringify(r) + '\n');
    }
  }
}
