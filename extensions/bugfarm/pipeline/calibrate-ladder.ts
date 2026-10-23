// Calibration ladder: the pure decision logic, with no I/O, so it can be tested on its own.
//
// Each family's difficulty is measured on one model (no pooling). Its ladder grows the attempt
// count to 2, 4, 8 and 16 (cumulative) and stops early when the family finds the task too easy
// (2/2, 3/4 or 4/8 passes). Errors count as attempts and are never replaced. While any attempt is
// running, nothing is decided. Calibration selects tasks; it does not measure them precisely (the
// benchmark does, on separate attempts), so it stops as soon as the decision can no longer change.

export type Family = 'anthropic' | 'openai' | 'google' | 'open';
export const FAMILIES: readonly Family[] = ['anthropic', 'openai', 'google', 'open'];

export type AttemptResult = 'pass' | 'fail' | 'error';

export interface LadderConfig {
  /** Cumulative attempt targets, ascending. The last one is the cap. */
  stages: number[];
  /** Passes at (or above) which a family stops early as too easy, keyed by stage. */
  too_easy: Record<string, number>;
}

export const DEFAULT_LADDER: LadderConfig = {
  stages: [2, 4, 8, 16],
  too_easy: { '2': 2, '4': 3, '8': 4 },
};

export interface BandConfig {
  /** A task needs at least this many passes in at least one family (someone can solve it). */
  min_passes_any_family: number;
  /** The frontier family's pass rate must not exceed this share. */
  max_frontier_rate: number;
}

export const DEFAULT_BAND: BandConfig = { min_passes_any_family: 1, max_frontier_rate: 0.5 };

export interface Tally {
  /** Finished attempts, errors included. */
  attempts: number;
  passes: number;
  fails: number;
  errors: number;
  /** Launched and not finished yet. */
  pending: number;
}

export function emptyTally(): Tally {
  return { attempts: 0, passes: 0, fails: 0, errors: 0, pending: 0 };
}

export function tally(results: Array<AttemptResult | 'pending'>): Tally {
  const t = emptyTally();
  for (const r of results) {
    if (r === 'pending') t.pending++;
    else {
      t.attempts++;
      if (r === 'pass') t.passes++;
      else if (r === 'fail') t.fails++;
      else t.errors++;
    }
  }
  return t;
}

export function cap(cfg: LadderConfig): number {
  return cfg.stages[cfg.stages.length - 1] ?? 0;
}

export type FamilyState =
  /** Attempts are still running; decide nothing. */
  | { kind: 'hold' }
  /** Stopped early: too easy at this stage. */
  | { kind: 'too_easy'; stage: number }
  /** Reached the cap. */
  | { kind: 'complete' }
  /** Needs more attempts: grow to `target`, launching `launch` now. */
  | { kind: 'next'; target: number; launch: number };

/** The largest ladder stage a finished-attempt count has reached, or 0. */
export function stageReached(n: number, cfg: LadderConfig = DEFAULT_LADDER): number {
  let s = 0;
  for (const st of cfg.stages) if (st <= n) s = st;
  return s;
}

/** Where one family's ladder stands, from its tally alone. */
export function familyState(t: Tally, cfg: LadderConfig = DEFAULT_LADDER): FamilyState {
  if (t.pending > 0) return { kind: 'hold' };
  const n = t.attempts;
  const stage = stageReached(n, cfg);
  if (stage > 0) {
    const threshold = cfg.too_easy[String(stage)];
    if (threshold !== undefined && t.passes >= threshold) return { kind: 'too_easy', stage };
  }
  if (n >= cap(cfg)) return { kind: 'complete' };
  const target = cfg.stages.find((s) => s > n) ?? cap(cfg);
  return { kind: 'next', target, launch: target - n };
}

export type Decision = 'accept' | 'too_easy' | 'unsolved_review' | 'out_of_band' | 'over_budget' | 'held';

export interface FamilyView {
  family: Family;
  model: string;
  tally: Tally;
  /** True when the budget gate refused this family's next stage. */
  budget_blocked?: boolean;
}

/**
 * A verdict the frontier family settles on its own, whatever the other families do: it stopped
 * early as too easy, or it already has more passes than the ceiling allows at the cap.
 */
export function frontierVerdict(t: Tally, cfg: LadderConfig = DEFAULT_LADDER, band: BandConfig = DEFAULT_BAND): 'too_easy' | 'out_of_band' | null {
  if (t.pending > 0) return null;
  if (familyState(t, cfg).kind === 'too_easy') return 'too_easy';
  if (t.passes > band.max_frontier_rate * cap(cfg)) return 'out_of_band';
  return null;
}

/** The frontier family cannot end above the ceiling, even if every remaining attempt passes. */
export function ceilingCertain(t: Tally, cfg: LadderConfig = DEFAULT_LADDER, band: BandConfig = DEFAULT_BAND): boolean {
  const remaining = Math.max(0, cap(cfg) - t.attempts - t.pending);
  return t.passes + t.pending + remaining <= band.max_frontier_rate * cap(cfg);
}

function decideCounting(families: FamilyView[], frontier: Family, cfg: LadderConfig, band: BandConfig): Decision | null {
  const f = families.find((x) => x.family === frontier);
  if (!f) throw new Error(`frontier family ${frontier} has no ladder model on the panel`);
  const verdict = frontierVerdict(f.tally, cfg, band);
  if (verdict) return verdict;
  const floorMet = families.some((x) => x.tally.passes >= band.min_passes_any_family);
  if (floorMet && ceilingCertain(f.tally, cfg, band)) return 'accept';
  const open = families.filter((x) => familyState(x.tally, cfg).kind === 'next');
  if (open.length > 0) return open.every((x) => x.budget_blocked) ? 'over_budget' : null;
  // Every family stopped (too easy or at the cap).
  if (!floorMet) return 'unsolved_review';
  const rate = f.tally.attempts > 0 ? f.tally.passes / f.tally.attempts : 0;
  return rate > band.max_frontier_rate ? 'out_of_band' : 'accept';
}

function asPasses(t: Tally): Tally {
  return { ...t, passes: t.passes + t.errors, errors: 0 };
}

/**
 * The task's decision, or null while it is still open. `families` holds every family on the panel
 * that has a ladder model; `frontier` names the family whose pass rate caps the band.
 *
 * - too_easy: the frontier family stopped early as too easy.
 * - out_of_band: the frontier pass rate is above the ceiling (at the cap, or already certain).
 * - unsolved_review: every family finished its ladder with no passes. "Unsolved" can mean broken,
 *   so a reviewer has to look.
 * - accept: someone passes sometimes, and the frontier cannot end above the ceiling.
 * - over_budget: the budget gate refused every stage still needed. Calling again with more budget
 *   resumes from the stored attempts.
 * - held: errored attempts could change the decision (it differs when they are read as passes),
 *   so a person has to look before the task moves on. Errors are never retried or replaced.
 *
 * Nothing is decided while any attempt is still running.
 */
export function decide(families: FamilyView[], frontier: Family, cfg: LadderConfig = DEFAULT_LADDER, band: BandConfig = DEFAULT_BAND): Decision | null {
  if (families.some((x) => x.tally.pending > 0)) return null;
  const asCounted = decideCounting(families, frontier, cfg, band);
  if (!families.some((x) => x.tally.errors > 0)) return asCounted;
  if (asCounted === null || asCounted === 'over_budget') return asCounted;
  const ifPassed = decideCounting(families.map((x) => ({ ...x, tally: asPasses(x.tally) })), frontier, cfg, band);
  return ifPassed === asCounted ? asCounted : 'held';
}

/**
 * What to launch next. The frontier family leads. Another family may only grow to the last stage
 * the frontier finished without a verdict, so a task that is too easy for the frontier costs the
 * other families nothing beyond the screen, while each family still runs in parallel with the
 * frontier's next stage. Once the frontier has finished its ladder, the others run freely.
 * Nothing is launched once the decision can no longer change.
 */
export function plan(families: FamilyView[], frontier: Family, cfg: LadderConfig = DEFAULT_LADDER, band: BandConfig = DEFAULT_BAND): Array<{ family: Family; model: string; launch: number; target: number }> {
  const f = families.find((x) => x.family === frontier);
  if (!f) return [];
  if (frontierVerdict(f.tally, cfg, band)) return [];
  const floorMet = families.some((x) => x.tally.passes >= band.min_passes_any_family);
  if (floorMet && ceilingCertain(f.tally, cfg, band)) return [];
  const fState = familyState(f.tally, cfg);
  const frontierDone = fState.kind === 'too_easy' || fState.kind === 'complete';
  const frontierStage = stageReached(f.tally.attempts, cfg);
  const out: Array<{ family: Family; model: string; launch: number; target: number }> = [];
  for (const x of families) {
    const st = familyState(x.tally, cfg);
    if (st.kind !== 'next') continue;
    let target = st.target;
    if (x.family !== frontier && !frontierDone) {
      const allowed = Math.min(target, frontierStage);
      if (allowed <= x.tally.attempts) continue;
      target = allowed;
    }
    const launch = target - x.tally.attempts;
    if (launch > 0) out.push({ family: x.family, model: x.model, launch, target });
  }
  return out;
}

/** Budget gate: a stage of k attempts starts only if the remaining budget covers k × (estimate + reserve). */
export function stageFits(remainingUsd: number, k: number, estimateUsd: number, reserveUsd: number): boolean {
  return remainingUsd + 1e-9 >= k * (estimateUsd + reserveUsd);
}

/** Wilson score interval for a pass rate, for reports. */
export function wilson(passes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = passes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
