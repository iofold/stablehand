import type { PassCount } from './shared/board.js';

/**
 * The hand-off to calibration (a separate module, ctx-jov1): after a task passes its controls,
 * the foreman calls `calibrate(taskDir, panel, budget)` and moves the card to Calibrating.
 *
 * Until that module lands, `pendingCalibration` records nothing and leaves the card there. A real
 * implementation runs the solver ladder on the panel, writes `attempt` rows, and answers with a
 * verdict and pass counts per model family.
 */

export interface PanelEntry {
  harness: string;
  model: string;
  family?: string;
}

export interface CalibrationPanel {
  /** Frozen before the campaign starts. */
  entries: PanelEntry[];
}

export interface CalibrationBudget {
  /** Dollars this task may spend on solver attempts. */
  maxUsd: number;
  /** Tags for the spend, e.g. `{ campaign, batch, item }`. */
  tags: Record<string, string>;
  /** Board item key, for `attempt` rows. */
  item: string;
}

export interface CalibrationOutcome {
  /** `pending`: handed off, no verdict yet. */
  state: 'pending' | 'accepted' | 'rejected';
  reason?: string;
  difficulty?: Record<string, PassCount>;
  costUsd?: number;
}

export type Calibrate = (taskDir: string, panel: CalibrationPanel, budget: CalibrationBudget) => Promise<CalibrationOutcome>;

export const pendingCalibration: Calibrate = async () => ({ state: 'pending' });

/** The default frozen panel: one cheap model per family, through the gateway. */
export const DEFAULT_PANEL: CalibrationPanel = {
  entries: [
    { harness: 'terminus-2', model: 'claude-haiku-4-5', family: 'anthropic' },
    { harness: 'terminus-2', model: 'gpt-5.4-mini', family: 'openai' },
    { harness: 'terminus-2', model: 'gemini-3.6-flash', family: 'google' },
    { harness: 'terminus-2', model: 'cf-glm-5.2', family: 'open' },
  ],
};
