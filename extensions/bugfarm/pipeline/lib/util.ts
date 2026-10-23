// Process, concurrency, filesystem and timing helpers. Node standard library only.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
  /** Keep at most this many bytes of stdout/stderr (the tail is kept). */
  maxBytes?: number;
  /** Called once when the timeout fires, before the child is killed (e.g. `docker kill`). */
  onTimeout?: () => Promise<void>;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly max: number;
  truncated = false;

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.size -= dropped.length;
      this.truncated = true;
    }
  }

  toString(): string {
    const text = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `[...truncated...]\n${text}` : text;
  }
}

/** Run a command without a shell. Never throws for a non-zero exit; check `code`. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = new TailBuffer(opts.maxBytes ?? DEFAULT_MAX_BYTES);
    const err = new TailBuffer(opts.maxBytes ?? DEFAULT_MAX_BYTES);
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const hook = opts.onTimeout ? opts.onTimeout() : Promise.resolve();
        hook
          .catch((e: unknown) => process.stderr.write(`onTimeout hook failed: ${String(e)}\n`))
          .finally(() => child.kill('SIGKILL'));
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout: out.toString(), stderr: err.toString(), ms: Date.now() - started, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run a command and throw with its stderr when it exits non-zero. Returns stdout. */
export async function runOk(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split('\n').slice(-15).join('\n');
    throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} exited ${r.code}${r.timedOut ? ' (timeout)' : ''}: ${tail}`);
  }
  return r.stdout;
}

/** A counting semaphore; `use` runs fn while holding one slot. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(slots: number) {
    this.available = slots;
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((r) => this.waiters.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    }
  }
}

/** Map with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function log(scope: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${scope.padEnd(8)} ${msg}\n`);
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeText(path: string, text: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, text);
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}

/** Apparent size of a directory tree in bytes (does not follow symlinks). */
export function duBytes(p: string): number {
  if (!existsSync(p)) return 0;
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of readdirSync(p)) total += duBytes(join(p, name));
  return total;
}

export function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

export function secs(ms: number): number {
  return Math.round(ms / 100) / 10;
}

/** Accumulates wall-clock time per named stage. */
export class StageTimer {
  readonly totals: Record<string, { ms: number; count: number }> = {};

  async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.add(stage, Date.now() - t0);
    }
  }

  add(stage: string, ms: number): void {
    const cur = this.totals[stage] ?? { ms: 0, count: 0 };
    cur.ms += ms;
    cur.count += 1;
    this.totals[stage] = cur;
  }

  summary(): Record<string, { seconds: number; count: number; mean_seconds: number }> {
    const out: Record<string, { seconds: number; count: number; mean_seconds: number }> = {};
    for (const [k, v] of Object.entries(this.totals)) {
      out[k] = { seconds: secs(v.ms), count: v.count, mean_seconds: secs(v.ms / Math.max(1, v.count)) };
    }
    return out;
  }
}

/** Parse `--key value` / `--flag` style arguments. Positional args land in `_`. */
export function parseArgs(argv: string[]): { _: string[]; [k: string]: string | boolean | string[] } {
  const out: { _: string[]; [k: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}
