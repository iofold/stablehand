// Benchmark statistics: pass@1 with a bootstrap interval, dollars per solve, median time.
//
// pass@1 for a cell is the mean over tasks of the share of that task's tries that passed (the
// unbiased pass@1 estimator, averaged per task so a task with more tries does not weigh more).
// The interval resamples tasks with replacement, because tries on the same task are correlated:
// resampling tries would make a 3-task benchmark look far more certain than it is.

export type Outcome = 'pass' | 'fail' | 'error';

export interface TaskTally {
  task: string;
  passes: number;
  tries: number;
}

/** Deterministic PRNG (mulberry32), so a report is reproducible from its records. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from a string (FNV-1a). */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mean over tasks of passes / tries. Tasks with no tries are left out. Null when nothing ran. */
export function passAt1(tasks: TaskTally[]): number | null {
  const ran = tasks.filter((t) => t.tries > 0);
  if (!ran.length) return null;
  return ran.reduce((s, t) => s + t.passes / t.tries, 0) / ran.length;
}

/** Linear-interpolated quantile of a sorted array (q in [0, 1]). */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface BootstrapCi {
  low: number;
  high: number;
  resamples: number;
}

/**
 * Percentile bootstrap over tasks: draw as many tasks as there are, with replacement, and take the
 * pass@1 of each draw. With a single task the interval collapses to that task's own share, which
 * says nothing about other tasks; callers should show the task count next to it.
 */
export function bootstrapPassAt1(tasks: TaskTally[], opts: { resamples?: number; seed: number; level?: number }): BootstrapCi | null {
  const ran = tasks.filter((t) => t.tries > 0);
  if (!ran.length) return null;
  const n = ran.length;
  const b = opts.resamples ?? 10_000;
  const level = opts.level ?? 0.95;
  const rand = mulberry32(opts.seed);
  const shares = ran.map((t) => t.passes / t.tries);
  const stats = new Array<number>(b);
  for (let i = 0; i < b; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += shares[Math.floor(rand() * n)];
    stats[i] = sum / n;
  }
  stats.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return { low: clamp01(quantile(stats, tail)), high: clamp01(quantile(stats, 1 - tail)), resamples: b };
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return quantile(v, 0.5);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

export interface AttemptLike {
  task: string;
  result: Outcome;
  cost_usd: number;
  seconds: number | null;
}

export interface CellStats {
  tasks: number;
  attempts: number;
  /** Tries that passed. */
  solved: number;
  /** Tasks with at least one passing try. */
  tasks_solved: number;
  errors: number;
  pass_at_1: number | null;
  ci_low: number | null;
  ci_high: number | null;
  cost_usd: number;
  /** Cell spend divided by passing tries; null with no passes. */
  usd_per_solve: number | null;
  usd_per_attempt: number | null;
  median_seconds: number | null;
}

/** Summarize a cell's finished measurement attempts (one per task and try). Errors count as unsolved tries. */
export function cellStats(attempts: AttemptLike[], seed: number, resamples = 10_000): CellStats {
  const byTask = new Map<string, TaskTally>();
  for (const a of attempts) {
    const t = byTask.get(a.task) ?? { task: a.task, passes: 0, tries: 0 };
    t.tries++;
    if (a.result === 'pass') t.passes++;
    byTask.set(a.task, t);
  }
  const tallies = [...byTask.values()].sort((x, y) => x.task.localeCompare(y.task));
  const p = passAt1(tallies);
  const ci = bootstrapPassAt1(tallies, { seed, resamples });
  const solved = attempts.filter((a) => a.result === 'pass').length;
  const cost = attempts.reduce((s, a) => s + (a.cost_usd || 0), 0);
  return {
    tasks: tallies.length,
    attempts: attempts.length,
    solved,
    tasks_solved: tallies.filter((t) => t.passes > 0).length,
    errors: attempts.filter((a) => a.result === 'error').length,
    pass_at_1: p === null ? null : round(p, 4),
    ci_low: ci ? round(ci.low, 4) : null,
    ci_high: ci ? round(ci.high, 4) : null,
    cost_usd: round(cost, 6),
    usd_per_solve: solved > 0 ? round(cost / solved, 4) : null,
    usd_per_attempt: attempts.length ? round(cost / attempts.length, 4) : null,
    median_seconds: (() => {
      const m = median(attempts.map((a) => a.seconds ?? NaN));
      return m === null ? null : round(m, 1);
    })(),
  };
}
