// Calibration ladder: the pure decision logic, with no I/O, so it can be tested on its own.
//
// Each family's difficulty is measured on one model (no pooling). Its ladder grows the attempt
// count to 2, 4, 8 and 16 (cumulative) and stops early when the family finds the task too easy
// (2/2, 3/4 or 4/8 passes). Errors count as attempts and are never replaced. While any attempt is
// running, nothing is decided. Calibration selects tasks; it does not measure them precisely (the
// benchmark does, on separate attempts), so it stops as soon as the decision can no longer change.
//
// A ladder config with `early` (panels from cal-v2 on) decides sooner: it accepts on the frontier's
// observed rate after a few attempts instead of waiting until the ceiling is certain, calls a task
// unsolved once nobody has passed by a fixed stage, and runs the other families only to find out
// whether anyone can solve the task. Without `early`, the cal-v1 rules apply unchanged.

export type Family = 'anthropic' | 'openai' | 'google' | 'open';
export const FAMILIES: readonly Family[] = ['anthropic', 'openai', 'google', 'open'];

export type AttemptResult = 'pass' | 'fail' | 'error';

export interface EarlyDecisions {
  /**
   * Accept once the frontier has this many finished attempts, has passed at most the band's
   * ceiling share of them, and some family has passed.
   */
  accept_after: number;
  /**
   * Call the task unsolved once nobody has passed, with the frontier at `frontier` finished
   * attempts and every other family at `others`. The other families stop there.
   */
  unsolved_after: { frontier: number; others: number };
}

export interface LadderConfig {
  /** Cumulative attempt targets, ascending. The last one is the cap. */
  stages: number[];
  /** Passes at (or above) which a family stops early as too easy, keyed by stage. */
  too_easy: Record<string, number>;
  /**
   * Early decisions (cal-v2 on). With it, the other families only run while nobody has passed:
   * their job in selection is to show that someone can solve the task. Unset keeps the cal-v1
   * rules: accept only once the ceiling is certain, and run every ladder to its cap before calling
   * a task unsolved.
   */
  early?: EarlyDecisions;
}

export const DEFAULT_LADDER: LadderConfig = {
  stages: [2, 4, 8, 16],
  too_easy: { '2': 2, '4': 3, '8': 4 },
};

/**
 * The cal-v2 ladder: the same stages and too-easy stops, plus early decisions. Accept after 4
 * frontier attempts with at most 2 passes and a pass somewhere; unsolved when nobody has passed
 * with the frontier at 4 and the other families at 8.
 */
export const EARLY_LADDER: LadderConfig = {
  ...DEFAULT_LADDER,
  early: { accept_after: 4, unsolved_after: { frontier: 4, others: 8 } },
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

/**
 * Early accept (needs `early`): the frontier has enough finished attempts to read its rate, and the
 * rate is at or under the ceiling.
 */
export function frontierSettled(t: Tally, cfg: LadderConfig = DEFAULT_LADDER, band: BandConfig = DEFAULT_BAND): boolean {
  if (!cfg.early || t.pending > 0) return false;
  return t.attempts >= cfg.early.accept_after && t.passes <= band.max_frontier_rate * t.attempts;
}

function floorMet(families: FamilyView[], band: BandConfig): boolean {
  return families.some((x) => x.tally.passes >= band.min_passes_any_family);
}

/** Does this family's ladder still need attempts for the decision? Attempts in flight are ignored. */
function needsMore(x: FamilyView, isFrontier: boolean, floor: boolean, cfg: LadderConfig, band: BandConfig): boolean {
  if (familyState({ ...x.tally, pending: 0 }, cfg).kind !== 'next') return false;
  const e = cfg.early;
  if (!e) return true;
  if (isFrontier) {
    // With a pass somewhere, the frontier stops once its rate can be read. With none, it stops at
    // the unsolved stage, and the other families look for a pass.
    const enough = floor ? e.accept_after : Math.max(e.accept_after, e.unsolved_after.frontier);
    return !(x.tally.attempts >= enough && x.tally.passes <= band.max_frontier_rate * x.tally.attempts);
  }
  return !floor && x.tally.attempts < e.unsolved_after.others;
}

function decideCounting(families: FamilyView[], frontier: Family, cfg: LadderConfig, band: BandConfig): Decision | null {
  const f = families.find((x) => x.family === frontier);
  if (!f) throw new Error(`frontier family ${frontier} has no ladder model on the panel`);
  const verdict = frontierVerdict(f.tally, cfg, band);
  if (verdict) return verdict;
  const floor = floorMet(families, band);
  if (floor && (ceilingCertain(f.tally, cfg, band) || frontierSettled(f.tally, cfg, band))) return 'accept';
  const open = families.filter((x) => needsMore(x, x.family === frontier, floor, cfg, band));
  if (open.length > 0) return open.every((x) => x.budget_blocked) ? 'over_budget' : null;
  // Every ladder the decision needs has stopped: too easy, at its cap, or at the unsolved stage.
  if (!floor) return 'unsolved_review';
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
 * - unsolved_review: every family finished its ladder with no passes (with `early`: the frontier
 *   at `unsolved_after.frontier` attempts and the others at `unsolved_after.others`). "Unsolved"
 *   can mean broken, so a reviewer has to look.
 * - accept: someone passes sometimes, and the frontier cannot end above the ceiling. With
 *   `early`, also as soon as the frontier has `accept_after` attempts at or under the ceiling.
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
 * Nothing is launched once the decision can no longer change. With `early`, a family only grows
 * while the decision needs it: the frontier until its rate can be read (or the unsolved stage),
 * the others only while nobody has passed, up to `unsolved_after.others`.
 */
export function plan(families: FamilyView[], frontier: Family, cfg: LadderConfig = DEFAULT_LADDER, band: BandConfig = DEFAULT_BAND): Array<{ family: Family; model: string; launch: number; target: number }> {
  const f = families.find((x) => x.family === frontier);
  if (!f) return [];
  if (frontierVerdict(f.tally, cfg, band)) return [];
  const floor = floorMet(families, band);
  if (floor && (ceilingCertain(f.tally, cfg, band) || frontierSettled(f.tally, cfg, band))) return [];
  const frontierDone = f.tally.pending === 0 && !needsMore(f, true, floor, cfg, band);
  const frontierStage = stageReached(f.tally.attempts, cfg);
  const out: Array<{ family: Family; model: string; launch: number; target: number }> = [];
  for (const x of families) {
    const st = familyState(x.tally, cfg);
    if (st.kind !== 'next') continue;
    if (!needsMore(x, x.family === frontier, floor, cfg, band)) continue;
    let target = st.target;
    if (x.family !== frontier && cfg.early) target = Math.min(target, cfg.early.unsolved_after.others);
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

/**
 * Attempts the frontier's next stage would launch, or 0 when the frontier needs no more. The
 * calibrator holds budget for that stage while other families' stages run.
 */
export function frontierNextLaunch(families: FamilyView[], frontier: Family, cfg: LadderConfig = DEFAULT_LADDER, band: BandConfig = DEFAULT_BAND): number {
  const f = families.find((x) => x.family === frontier);
  if (!f || frontierVerdict(f.tally, cfg, band)) return 0;
  const floor = floorMet(families, band);
  if (floor && (ceilingCertain(f.tally, cfg, band) || frontierSettled(f.tally, cfg, band))) return 0;
  if (f.tally.pending === 0 && !needsMore(f, true, floor, cfg, band)) return 0;
  const launched = f.tally.attempts + f.tally.pending;
  if (launched >= cap(cfg)) return 0;
  const target = cfg.stages.find((s) => s > launched) ?? cap(cfg);
  return target - launched;
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
