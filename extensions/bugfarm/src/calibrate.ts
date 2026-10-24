import { panelV2 } from '../pipeline/calibrate-panel.ts';
import type { PassCount } from './shared/board.js';

/**
 * The hand-off to calibration: after a task passes its controls, the foreman calls
 * `calibrate(taskDir, panel, budget)` with the task's final, leak-checked instruction already
 * packaged, and moves the card to Accepted or Rejected on the answer.
 *
 * The worker wires `foremanCalibrate` (pipeline/calibrate-foreman.ts) in here: it runs the solver
 * ladder on a frozen panel, writes `attempt` rows and per-family difficulty, and answers with a
 * verdict. Without a frozen panel and a campaign gateway key, `pendingCalibration` records
 * nothing and leaves the card waiting in Calibrating.
 */

export interface PanelEntry {
  harness: string;
  model: string;
  family?: string;
}

export interface CalibrationPanel {
  /** Frozen panel id, e.g. `cal-v2`. */
  id?: string;
  /** Frozen before the campaign starts: one measured model per family. */
  entries: PanelEntry[];
}

export interface CampaignBudget {
  /** Board key of the campaign. */
  id: string;
  /** The campaign's cap: floor turns and calibration together. */
  capUsd: number;
  /** What the campaign has spent outside calibration so far (floor turns), read when a stage is gated. */
  otherSpendUsd: () => number;
}

export interface CalibrationBudget {
  /** Dollars this task may spend on solver attempts, prior attempts on the same card included. */
  maxUsd: number;
  /** Tags for the spend, e.g. `{ campaign, batch, item }`. */
  tags: Record<string, string>;
  /** Board item key, for `attempt` rows. */
  item: string;
  /**
   * The campaign's own budget gate: a stage only launches if what is left of the campaign's cap
   * covers it, across every task calibrating at once.
   */
  campaign?: CampaignBudget;
}

export interface CalibrationOutcome {
  /** `pending`: handed off, no verdict yet. */
  state: 'pending' | 'accepted' | 'rejected';
  reason?: string;
  /** Plain-language detail for a rejection, e.g. the pass counts per family. */
  detail?: string;
  difficulty?: Record<string, PassCount>;
  costUsd?: number;
}

export type Calibrate = (taskDir: string, panel: CalibrationPanel, budget: CalibrationBudget) => Promise<CalibrationOutcome>;

export const pendingCalibration: Calibrate = async () => ({ state: 'pending' });

/** The foreman's view of a panel: its measured (ladder) model per family. */
export function panelEntries(panel: { id: string; harness: string; families: Array<{ family: string; ladder: string | null }> }): CalibrationPanel {
  return {
    id: panel.id,
    entries: panel.families
      .filter((f): f is { family: string; ladder: string } => Boolean(f.ladder))
      .map((f) => ({ harness: panel.harness, model: f.ladder, family: f.family })),
  };
}

/** The default panel: the measured models of frozen panel cal-v2, one per family (no Gemini yet). */
export const DEFAULT_PANEL: CalibrationPanel = panelEntries(panelV2());

/** Families the panel measures, in order: what the board's difficulty dots stand for. */
export function panelFamilies(panel: CalibrationPanel): string[] {
  const out: string[] = [];
  for (const e of panel.entries) if (e.family && !out.includes(e.family)) out.push(e.family);
  return out;
}
