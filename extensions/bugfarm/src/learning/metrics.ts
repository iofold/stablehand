import type { AttemptPayload, ItemPayload, TurnPayload } from '../shared/board.js';
import type { BatchLearning, BatchNumbers, LearningGate } from '../shared/learning.js';

/**
 * One batch's learning numbers, from the board rows alone, so they can be recomputed at any time
 * and come out the same.
 *
 * Accepted share is accepted ÷ decided at the campaign's gate. Dollars per accepted task is the
 * batch's spend at that gate ÷ accepted. The one-off environment build is left out of the spend
 * (it lands on whichever batch first needs the environment), the Teacher turn that wrote the
 * batch's rules is in it.
 */

/** Calibration's verdicts that reject a task which passed its controls. */
export const CALIBRATION_REJECTS: ReadonlySet<string> = new Set(['too_easy', 'out_of_band', 'unsolved_review', 'unsolved_broken']);
/** Calibration outcomes that are not verdicts on the task: it waits for more budget. */
export const CALIBRATION_PENDING: ReadonlySet<string> = new Set(['over_budget', 'held']);

export interface MetricsInput {
  batch: number;
  gate: LearningGate;
  items: ItemPayload[];
  /** The campaign's floor turns (any batch; only this batch's are counted). */
  turns: TurnPayload[];
  /** Calibration attempts on this campaign's items (any batch). */
  attempts: Array<AttemptPayload & { key?: string }>;
  itemKeys: string[];
  filteredBy?: Record<string, number>;
  filtered?: number;
  rulesServed?: string[];
  now?: number;
}

/** The card passed its oracle and nop controls (it may have been decided by calibration since). */
export function passedControls(item: ItemPayload): boolean {
  if (item.stage === 'calibrating' || item.stage === 'accepted' || item.stage === 'published') return true;
  const controls = item.controls as { oracle?: unknown } | undefined;
  return Boolean(controls && typeof controls === 'object' && typeof controls.oracle === 'number');
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The gate a campaign measures at, picked once from its first batch. */
export function gateFromItems(items: ItemPayload[]): LearningGate {
  const verdict = items.some((item) => item.stage === 'accepted' || item.stage === 'published'
    || (item.stage === 'rejected' && passedControls(item) && CALIBRATION_REJECTS.has(item.reject_reason ?? '')));
  return verdict ? 'calibration' : 'controls';
}

export function batchMetrics(input: MetricsInput): BatchLearning {
  const own = input.items.filter((item) => item.batch === input.batch);
  let passed = 0;
  let calibrated = 0;
  const reasonsBefore: Record<string, number> = {};
  const reasonsCalibration: Record<string, number> = {};
  let rejectedBefore = 0;
  let rejectedCalibration = 0;
  for (const item of own) {
    const through = passedControls(item);
    if (through) passed++;
    if (item.stage === 'accepted' || item.stage === 'published') calibrated++;
    if (item.stage !== 'rejected') continue;
    const reason = item.reject_reason ?? 'unknown';
    if (!through) {
      rejectedBefore++;
      reasonsBefore[reason] = (reasonsBefore[reason] ?? 0) + 1;
    } else if (!CALIBRATION_PENDING.has(reason)) {
      rejectedCalibration++;
      reasonsCalibration[reason] = (reasonsCalibration[reason] ?? 0) + 1;
    }
  }

  let floor = 0;
  let setup = 0;
  let teacher = 0;
  for (const turn of input.turns) {
    if (turn.batch !== input.batch) continue;
    const cost = typeof turn.cost_usd === 'number' && Number.isFinite(turn.cost_usd) ? turn.cost_usd : 0;
    if (turn.stage === 'env') setup += cost;
    else {
      floor += cost;
      if (turn.role === 'teacher') teacher += cost;
    }
  }
  const keys = new Set(input.itemKeys);
  let calibrationUsd = 0;
  for (const attempt of input.attempts) {
    if (attempt.phase === 'benchmark' || !keys.has(attempt.item)) continue;
    calibrationUsd += typeof attempt.cost_usd === 'number' ? attempt.cost_usd : 0;
  }

  const calibration = input.gate === 'calibration';
  const accepted = calibration ? calibrated : passed;
  const decided = calibration ? calibrated + rejectedBefore + rejectedCalibration : passed + rejectedBefore;
  const reasons = calibration ? mergeCounts(reasonsBefore, reasonsCalibration) : reasonsBefore;
  const cost = calibration ? floor + calibrationUsd : floor;
  return {
    batch: input.batch,
    gate: input.gate,
    candidates: own.length,
    accepted,
    decided,
    share: decided > 0 ? round(accepted / decided) : null,
    cost_usd: round(cost),
    usd_per_accepted: accepted > 0 ? round(cost / accepted) : null,
    reasons,
    passed_controls: passed,
    floor_usd: round(floor),
    teacher_usd: round(teacher),
    setup_usd: round(setup),
    calibration_usd: round(calibrationUsd),
    filtered: input.filtered ?? 0,
    filtered_by: input.filteredBy ?? {},
    rules_served: input.rulesServed ?? [],
    computed_at: input.now ?? Date.now(),
  };
}

function mergeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) out[key] = (out[key] ?? 0) + value;
  return out;
}

export function numbersOf(learning: BatchLearning): BatchNumbers {
  return {
    batch: learning.batch,
    accepted: learning.accepted,
    decided: learning.decided,
    share: learning.share,
    cost_usd: learning.cost_usd,
    usd_per_accepted: learning.usd_per_accepted,
  };
}
