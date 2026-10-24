// The foreman's calibration contract (`src/calibrate.ts`: `Calibrate`) on top of calibrate().
//
//   import { foremanCalibrate } from '../pipeline/calibrate-foreman.ts';
//   new Foreman({ ..., calibrate: foremanCalibrate({ panel: 'cal-v1', gateway }), panel: DEFAULT_PANEL });
//
// The frozen panel is the source of truth: results never pool across panels, so the foreman's
// panel entries are only checked against it, and a mismatch is logged once. The foreman owns the
// item's stage; this adapter writes attempts and per-family difficulty but never moves the card.
import type { Calibrate, CalibrationOutcome, CalibrationPanel } from '../src/calibrate.js';
import type { BoardSink } from './calibrate-board.ts';
import { CostModel, calibrate } from './calibrate.ts';
import type { CalibrationResult, GatewayContext } from './calibrate.ts';
import { loadFrozenPanel } from './calibrate-panel.ts';
import type { FrozenPanel } from './calibrate-panel.ts';
import { Semaphore, log } from './lib/util.ts';

export interface ForemanCalibrateOptions {
  /** A frozen panel, or its id under `.work/calibration/panels/`. */
  panel: FrozenPanel | string;
  gateway: GatewayContext;
  board?: BoardSink;
  /** Trial slots shared by every task the foreman hands over (default 6). */
  slots?: Semaphore;
}

/** Entries of the foreman's panel that differ from the frozen panel's ladder models, as text. */
export function panelMismatch(frozen: FrozenPanel, requested: CalibrationPanel): string | null {
  const ladder = new Map(frozen.families.filter((f) => f.ladder).map((f) => [f.family as string, f.ladder as string]));
  const diffs: string[] = [];
  for (const e of requested.entries) {
    const family = e.family ?? frozen.models[e.model]?.family;
    if (!family) {
      diffs.push(`${e.model}: unknown family`);
      continue;
    }
    const want = ladder.get(family);
    if (want !== e.model || e.harness !== frozen.harness) diffs.push(`${family}: asked ${e.harness}/${e.model}, frozen ${frozen.harness}/${want ?? 'none'}`);
  }
  return diffs.length ? diffs.join('; ') : null;
}

/** calibrate()'s result in the foreman's terms. */
export function toOutcome(r: CalibrationResult): CalibrationOutcome {
  const difficulty: Record<string, { passes: number; attempts: number }> = {};
  for (const [family, f] of Object.entries(r.perFamily)) if (f) difficulty[family] = { passes: f.passes, attempts: f.attempts };
  const base = { difficulty, costUsd: r.cost };
  switch (r.decision) {
    case 'accept':
      return { ...base, state: 'accepted' };
    case 'screened':
      return { ...base, state: 'pending' };
    case 'held':
      // Errored attempts could flip the decision: a person looks before the card moves.
      return { ...base, state: 'pending', reason: 'held_errors' };
    default:
      // too_easy, out_of_band, unsolved_review, over_budget. Calling calibrate again with more
      // budget resumes an over_budget task from its stored attempts.
      return { ...base, state: 'rejected', reason: r.decision };
  }
}

export function foremanCalibrate(opts: ForemanCalibrateOptions): Calibrate {
  const panel = typeof opts.panel === 'string' ? loadFrozenPanel(opts.panel) : opts.panel;
  const slots = opts.slots ?? new Semaphore(6);
  const costModel = new CostModel(panel.models);
  let warned = false;
  return async (taskDir, requested, budget) => {
    const mismatch = panelMismatch(panel, requested);
    if (mismatch && !warned) {
      warned = true;
      log('cal', `the foreman's panel differs from frozen panel ${panel.id}; calibrating on ${panel.id} (${mismatch})`);
    }
    const r = await calibrate(taskDir, panel, budget.maxUsd, {
      gateway: opts.gateway,
      board: opts.board,
      slots,
      costModel,
      itemKey: budget.item,
      writeStage: false,
      spendTags: budget.tags,
      runId: budget.tags.campaign ? `${budget.tags.campaign}-${panel.id}` : undefined,
    });
    return toOutcome(r);
  };
}
