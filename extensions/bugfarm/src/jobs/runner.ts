import { createHash, randomUUID } from 'node:crypto';
import type { BoardRow, JobKind, JobPayload } from '../shared/board.js';
import type { UpsertInput } from '../store/validate.js';

/**
 * Pipeline jobs: build an env, check a candidate, package a task, run its controls.
 *
 * A job is a `job` row in the board store, so it survives a worker restart: on start the runner
 * re-queues every job that was queued or running. Handlers must be safe to run again from the
 * top; the pipeline steps are (they rebuild their trees and reuse cached images).
 *
 * Floor agents reach jobs through two HTTP tools, `start_job` and `job_status`, because a sandbox
 * tool call times out after 5 minutes and a check or a build can take longer. The foreman uses
 * the same runner directly.
 */

export interface JobContext {
  id: string;
  args: Record<string, unknown>;
  /** Write a progress line on the job (and, through the handler, on the board card). */
  progress(message: string): Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

export interface JobStore {
  upsert(rows: UpsertInput[]): Promise<{ rows: BoardRow[] }>;
  latest(kind: 'job', key: string): Promise<BoardRow | null>;
  currentOfKind(kind: 'job'): Promise<BoardRow<'job'>[]>;
}

interface Logger {
  log(message: string): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface JobRecord extends JobPayload {
  id: string;
}

export interface SubmitOptions {
  /** Deterministic id: submitting an id that exists returns that job instead of starting another. */
  id?: string;
  owner?: 'foreman' | 'agent';
  campaign?: string | null;
  item?: string | null;
  turnId?: string | null;
  /** Start a fresh run even when a job with this id already finished. */
  rerun?: boolean;
}

class Slots {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(size: number) {
    this.free = Math.max(1, size);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/** A job id derived from what it does, so the same request twice is the same job. */
export function jobIdFor(kind: JobKind, args: Record<string, unknown>, scope = ''): string {
  const digest = createHash('sha256').update(JSON.stringify([kind, scope, sortKeys(args)])).digest('hex').slice(0, 16);
  return `${kind}-${digest}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

function toRecord(row: BoardRow | null): JobRecord | null {
  return row ? { ...(row.payload as JobPayload), id: row.key } : null;
}

const TERMINAL = new Set(['done', 'failed']);

export class JobRunner {
  private readonly slots = new Map<JobKind, Slots>();
  private readonly running = new Map<string, Promise<JobRecord>>();
  private readonly listeners = new Map<string, Set<(job: JobRecord) => void>>();
  private stopped = false;

  constructor(
    private readonly deps: {
      store: JobStore;
      handlers: Record<JobKind, JobHandler>;
      /** Concurrent jobs per kind. */
      limits: Partial<Record<JobKind, number>>;
      logger?: Logger;
      now?: () => number;
    },
  ) {
    for (const kind of Object.keys(deps.handlers) as JobKind[]) {
      this.slots.set(kind, new Slots(deps.limits[kind] ?? 1));
    }
  }

  private get logger(): Logger {
    return this.deps.logger ?? console;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Re-queue every job a previous process left queued or running. Returns how many resumed. */
  async resume(): Promise<number> {
    const open = (await this.deps.store.currentOfKind('job')).filter((row) => !TERMINAL.has(row.payload.status));
    for (const row of open) {
      const job = toRecord(row) as JobRecord;
      this.logger.log(`[bugfarm] jobs: resuming ${job.kind} ${job.id} (was ${job.status} when the worker stopped)`);
      this.launch(job);
    }
    return open.length;
  }

  stop(): void {
    this.stopped = true;
  }

  async get(id: string): Promise<JobRecord | null> {
    return toRecord(await this.deps.store.latest('job', id));
  }

  async submit(kind: JobKind, args: Record<string, unknown>, opts: SubmitOptions = {}): Promise<JobRecord> {
    if (!this.deps.handlers[kind]) throw new Error(`unknown job kind ${kind}`);
    const id = opts.id ?? randomUUID();
    const existing = await this.get(id);
    if (existing && !(opts.rerun && TERMINAL.has(existing.status))) {
      if (!TERMINAL.has(existing.status) && !this.running.has(id)) this.launch(existing);
      return existing;
    }
    const job: JobPayload = {
      kind,
      status: 'queued',
      args,
      progress: 'Waiting for a free slot',
      result: null,
      error: null,
      owner: opts.owner ?? 'agent',
      campaign: opts.campaign ?? null,
      item: opts.item ?? null,
      turn_id: opts.turnId ?? null,
      runs: existing?.runs ?? 0,
      created_at: this.now(),
      started_at: null,
      finished_at: null,
    };
    await this.write(id, job, 'replace');
    const record = { ...job, id };
    this.launch(record);
    return record;
  }

  /**
   * Wait until the job finishes or `timeoutMs` passes, whichever is first, and return its latest
   * state. A job that is still running comes back as running; poll again.
   */
  async wait(id: string, timeoutMs: number): Promise<JobRecord | null> {
    const current = await this.get(id);
    if (!current || TERMINAL.has(current.status) || timeoutMs <= 0) return current;
    return new Promise<JobRecord | null>((resolve) => {
      const listeners = this.listeners.get(id) ?? new Set();
      this.listeners.set(id, listeners);
      const done = (job: JobRecord) => {
        clearTimeout(timer);
        listeners.delete(done);
        resolve(job);
      };
      const timer = setTimeout(() => {
        listeners.delete(done);
        void this.get(id).then(resolve, () => resolve(current));
      }, timeoutMs);
      listeners.add(done);
    });
  }

  /** Wait for the job to finish, however long it takes (the foreman's path). */
  async settle(id: string): Promise<JobRecord> {
    for (;;) {
      const job = await this.wait(id, 60_000);
      if (!job) throw new Error(`job ${id} disappeared`);
      if (TERMINAL.has(job.status)) return job;
    }
  }

  private async write(id: string, payload: Partial<JobPayload>, mode: 'merge' | 'replace' = 'merge'): Promise<void> {
    await this.deps.store.upsert([{ kind: 'job', key: id, payload: payload as Record<string, unknown>, mode }]);
  }

  private launch(job: JobRecord): void {
    if (this.running.has(job.id) || this.stopped) return;
    const promise = this.execute(job).finally(() => this.running.delete(job.id));
    this.running.set(job.id, promise);
  }

  private async execute(job: JobRecord): Promise<JobRecord> {
    const slots = this.slots.get(job.kind);
    if (!slots) throw new Error(`no handler for ${job.kind}`);
    return slots.run(async () => {
      const runs = (job.runs ?? 0) + 1;
      await this.write(job.id, { status: 'running', started_at: this.now(), runs, progress: runs > 1 ? 'Resumed after a restart' : 'Started' });
      let final: Partial<JobPayload>;
      try {
        const result = await this.deps.handlers[job.kind]({
          id: job.id,
          args: job.args,
          progress: (message) => this.write(job.id, { progress: message.slice(0, 2000) }),
        });
        final = { status: 'done', result, error: null, progress: null, finished_at: this.now() };
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        this.logger.warn(`[bugfarm] jobs: ${job.kind} ${job.id} failed: ${message.split('\n')[0]}`);
        final = { status: 'failed', error: message.slice(0, 8000), progress: null, finished_at: this.now() };
      }
      await this.write(job.id, final);
      const record = { ...job, ...final, runs } as JobRecord;
      for (const listener of [...(this.listeners.get(job.id) ?? [])]) listener(record);
      return record;
    });
  }
}
