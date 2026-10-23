import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { BoardRow, RowKind } from '../shared/board.js';
import { contentSha, isPlainObject, mergePayload } from './payload.js';
import { validatePayload, type UpsertInput } from './validate.js';

/**
 * The board store: one append-only table in its own Postgres schema.
 *
 *   rows(id bigserial, kind, key, content_sha, payload jsonb, created_at)
 *
 * The current state of a thing is its latest row per (kind, key). Readers
 * follow the table with a cursor, the highest id they have seen.
 *
 * Writers serialize on a transaction-scoped advisory lock, so ids become
 * visible in the order they were assigned. Without it, a reader could see id
 * 11 commit before id 10 and skip 10 forever.
 */

export interface BoardStoreOptions {
  url: string;
  /** Postgres schema that holds the board tables. Default `bugfarm`. */
  schema?: string;
  maxConnections?: number;
}

export interface UpsertOutcome {
  kind: RowKind;
  key: string;
  /** The new row id, or null when the payload was unchanged and nothing was written. */
  id: number | null;
  changed: boolean;
}

export interface UpsertResult {
  cursor: number;
  results: UpsertOutcome[];
  rows: BoardRow[];
}

export class UpsertValidationError extends Error {
  constructor(
    readonly index: number,
    readonly kind: string,
    readonly key: string,
    readonly detail: string,
  ) {
    super(`rows[${index}] (${kind} ${key}): ${detail}`);
  }
}

export type ResetScope = 'all' | 'simulated';

interface DbRow {
  id: string;
  kind: RowKind;
  key: string;
  content_sha: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * postgres.js types `TransactionSql` as `Omit<Sql, ...>`, which drops the
 * tagged-template call signature under TypeScript 5. At runtime it is the
 * same callable; this restores the type in one place.
 */
function asSql(tx: postgres.TransactionSql): postgres.Sql {
  return tx as unknown as postgres.Sql;
}

function toBoardRow(row: DbRow): BoardRow {
  return {
    id: Number(row.id),
    kind: row.kind,
    key: row.key,
    content_sha: row.content_sha,
    payload: row.payload as unknown as BoardRow['payload'],
    created_at: row.created_at.getTime(),
  };
}

/**
 * Fill in what the worker owns: the first time an item reaches a stage, its
 * entry time is stamped unless the writer sent one.
 */
export function normalizePayload(
  kind: RowKind,
  payload: Record<string, unknown>,
  now: number,
): Record<string, unknown> {
  if (kind !== 'item' || typeof payload.stage !== 'string') return payload;
  const stageTimes = isPlainObject(payload.stage_times) ? payload.stage_times : {};
  if (typeof stageTimes[payload.stage] === 'number') return payload;
  return { ...payload, stage_times: { ...stageTimes, [payload.stage]: now } };
}

export class BoardStore {
  readonly schema: string;
  readonly channel: string;
  private readonly sql: postgres.Sql;
  private readonly lockKey: string;

  constructor(options: BoardStoreOptions) {
    const schema = options.schema ?? 'bugfarm';
    if (!SCHEMA_PATTERN.test(schema)) {
      throw new Error(`BUGFARM_DB_SCHEMA must be a lowercase identifier, got "${schema}"`);
    }
    this.schema = schema;
    this.channel = `bugfarm_changes_${schema}`;
    this.lockKey = `bugfarm.rows:${schema}`;
    this.sql = postgres(options.url, {
      max: options.maxConnections ?? 5,
      onnotice: () => undefined,
      connection: { application_name: 'bugfarm-worker' },
    });
  }

  private table(name: 'rows' | 'meta'): postgres.Helper<string> {
    return this.sql(`${this.schema}.${name}`);
  }

  async migrate(): Promise<void> {
    const sql = this.sql;
    await sql.begin(async (transaction) => {
      const tx = asSql(transaction);
      await tx`select pg_advisory_xact_lock(hashtext(${`bugfarm.migrate:${this.schema}`}))`;
      await tx`create schema if not exists ${sql(this.schema)}`;
      await tx`
        create table if not exists ${this.table('rows')} (
          id bigserial primary key,
          kind text not null,
          key text not null,
          content_sha text not null,
          payload jsonb not null,
          created_at timestamptz not null default now()
        )`;
      await tx`create index if not exists rows_kind_key_id on ${this.table('rows')} (kind, key, id desc)`;
      await tx`
        create table if not exists ${this.table('meta')} (
          k text primary key,
          v text not null
        )`;
      await tx`insert into ${this.table('meta')} (k, v) values ('epoch', ${randomUUID()}) on conflict (k) do nothing`;
    });
  }

  /** Changes when the board is reset; clients holding another epoch reload. */
  async epoch(): Promise<string> {
    const [row] = await this.sql<{ v: string }[]>`select v from ${this.table('meta')} where k = 'epoch'`;
    return row?.v ?? 'none';
  }

  async cursor(): Promise<number> {
    const [row] = await this.sql<{ max: string | null }[]>`select max(id)::text as max from ${this.table('rows')}`;
    return row?.max ? Number(row.max) : 0;
  }

  /**
   * Write rows in one transaction. Each payload is merged into the latest one
   * for its (kind, key) unless `mode` is `replace`, then validated. A row
   * whose content hash matches the latest is skipped, so retries are free.
   * Any invalid row fails the whole call and nothing is written.
   */
  async upsert(inputs: UpsertInput[], now: number = Date.now()): Promise<UpsertResult> {
    return this.sql.begin(async (transaction) => {
      const tx = asSql(transaction);
      await tx`select pg_advisory_xact_lock(hashtext(${this.lockKey}))`;
      const results: UpsertOutcome[] = [];
      const written: BoardRow[] = [];
      // Rows earlier in the same call count as "latest" for later ones.
      const pending = new Map<string, { sha: string; payload: Record<string, unknown> }>();

      for (const [index, input] of inputs.entries()) {
        const mapKey = `${input.kind}\u0000${input.key}`;
        let latest = pending.get(mapKey);
        if (!latest) {
          const [row] = await tx<{ content_sha: string; payload: Record<string, unknown> }[]>`
            select content_sha, payload from ${this.table('rows')}
            where kind = ${input.kind} and key = ${input.key}
            order by id desc limit 1`;
          if (row) latest = { sha: row.content_sha, payload: row.payload };
        }

        const merged = input.mode === 'replace' || !latest
          ? input.payload
          : mergePayload(latest.payload, input.payload);
        const checked = validatePayload(input.kind, merged);
        if (!checked.ok) throw new UpsertValidationError(index, input.kind, input.key, checked.error);
        const payload = normalizePayload(input.kind, checked.payload, now);
        const sha = contentSha(payload);

        if (latest && latest.sha === sha) {
          results.push({ kind: input.kind, key: input.key, id: null, changed: false });
          continue;
        }
        const [row] = await tx<DbRow[]>`
          insert into ${this.table('rows')} (kind, key, content_sha, payload)
          values (${input.kind}, ${input.key}, ${sha}, ${tx.json(payload as postgres.JSONValue)})
          returning id, kind, key, content_sha, payload, created_at`;
        const boardRow = toBoardRow(row);
        written.push(boardRow);
        pending.set(mapKey, { sha, payload });
        results.push({ kind: input.kind, key: input.key, id: boardRow.id, changed: true });
      }

      if (written.length > 0) {
        await tx`select pg_notify(${this.channel}, ${String(written[written.length - 1].id)})`;
      }
      const [max] = await tx<{ max: string | null }[]>`select max(id)::text as max from ${this.table('rows')}`;
      return { cursor: max?.max ? Number(max.max) : 0, results, rows: written };
    });
  }

  /** Rows written after `since`, oldest first. */
  async changes(since: number, limit = 1000): Promise<{ rows: BoardRow[]; cursor: number; more: boolean }> {
    const capped = Math.max(1, Math.min(limit, 5000));
    const rows = await this.sql<DbRow[]>`
      select id, kind, key, content_sha, payload, created_at from ${this.table('rows')}
      where id > ${since}
      order by id asc
      limit ${capped + 1}`;
    const more = rows.length > capped;
    const page = (more ? rows.slice(0, capped) : rows).map(toBoardRow);
    const cursor = page.length > 0 ? page[page.length - 1].id : since;
    return { rows: page, cursor, more };
  }

  /** The latest row for every (kind, key), plus the cursor they are current at. */
  async current(): Promise<{ rows: BoardRow[]; cursor: number; epoch: string }> {
    return this.sql.begin('isolation level repeatable read', async (transaction) => {
      const tx = asSql(transaction);
      const rows = await tx<DbRow[]>`
        select distinct on (kind, key) id, kind, key, content_sha, payload, created_at
        from ${this.table('rows')}
        order by kind, key, id desc`;
      const [max] = await tx<{ max: string | null }[]>`select max(id)::text as max from ${this.table('rows')}`;
      const [epoch] = await tx<{ v: string }[]>`select v from ${this.table('meta')} where k = 'epoch'`;
      return {
        rows: rows.map(toBoardRow).sort((a, b) => a.id - b.id),
        cursor: max?.max ? Number(max.max) : 0,
        epoch: epoch?.v ?? 'none',
      };
    });
  }

  async latest(kind: RowKind, key: string): Promise<BoardRow | null> {
    const [row] = await this.sql<DbRow[]>`
      select id, kind, key, content_sha, payload, created_at from ${this.table('rows')}
      where kind = ${kind} and key = ${key}
      order by id desc limit 1`;
    return row ? toBoardRow(row) : null;
  }

  /** Counts of current things, for the health check and the simulator's safety check. */
  async summary(): Promise<{ rows: number; simulatedKeys: number; realKeys: number }> {
    const [row] = await this.sql<{ rows: string; simulated: string; real: string }[]>`
      with latest as (
        select distinct on (kind, key) payload from ${this.table('rows')} order by kind, key, id desc
      )
      select
        (select count(*) from ${this.table('rows')})::text as rows,
        (select count(*) from latest where coalesce((payload->>'simulated')::boolean, false))::text as simulated,
        (select count(*) from latest where not coalesce((payload->>'simulated')::boolean, false))::text as real`;
    return { rows: Number(row.rows), simulatedKeys: Number(row.simulated), realKeys: Number(row.real) };
  }

  /**
   * Clear the board and start a new epoch. `simulated` removes only things
   * whose latest row came from the simulator. Ids keep counting up, so no
   * cursor is ever reused.
   */
  async reset(scope: ResetScope): Promise<{ epoch: string; deleted: number }> {
    return this.sql.begin(async (transaction) => {
      const tx = asSql(transaction);
      await tx`select pg_advisory_xact_lock(hashtext(${this.lockKey}))`;
      const deleted = scope === 'all'
        ? await tx`delete from ${this.table('rows')}`
        : await tx`
            delete from ${this.table('rows')} r
            using (
              select distinct on (kind, key) kind, key, payload from ${this.table('rows')}
              order by kind, key, id desc
            ) latest
            where r.kind = latest.kind and r.key = latest.key
              and coalesce((latest.payload->>'simulated')::boolean, false)`;
      const epoch = randomUUID();
      await tx`update ${this.table('meta')} set v = ${epoch} where k = 'epoch'`;
      await tx`select pg_notify(${this.channel}, ${`reset:${epoch}`})`;
      return { epoch, deleted: deleted.count };
    });
  }

  /** Call `onSignal` whenever any process commits a write or a reset to this board. */
  async listen(onSignal: (payload: string) => void): Promise<() => Promise<void>> {
    const subscription = await this.sql.listen(this.channel, onSignal);
    return async () => {
      await subscription.unlisten();
    };
  }

  async ping(): Promise<boolean> {
    await this.sql`select 1`;
    return true;
  }

  /** Drop the board schema. Tests only. */
  async dropSchema(): Promise<void> {
    await this.sql`drop schema if exists ${this.sql(this.schema)} cascade`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
