/**
 * What the learning loop writes to the board, shared by the worker and the Learning tab.
 *
 * After each batch the worker writes the batch's learning numbers on its `batch` row
 * (`learning`), measures the rules that were on trial in it (`rule` rows: status, effect), and
 * asks the Teacher for new rules from its rejects.
 */

/**
 * Where a candidate counts as accepted for the curve.
 * - `calibration`: calibration accepted it (the task is in the difficulty band).
 * - `controls`: it passed every check before calibration (fail→pass, leak review, package,
 *   oracle and nop controls). Used when a campaign runs without calibration verdicts.
 */
export type LearningGate = 'controls' | 'calibration';

export const GATE_LABELS: Record<LearningGate, string> = {
  controls: 'passed every check before calibration',
  calibration: 'accepted by calibration',
};

/** The numbers one rule is judged on: a batch, measured at the campaign's gate. */
export interface BatchNumbers {
  batch: number;
  accepted: number;
  decided: number;
  share: number | null;
  cost_usd: number;
  usd_per_accepted: number | null;
}

export interface BatchLearning extends BatchNumbers {
  gate: LearningGate;
  candidates: number;
  /** Rejection reasons among the decided candidates, with counts. */
  reasons: Record<string, number>;
  passed_controls: number;
  /** Floor-agent spend this batch: every turn but the one-off environment build. Part of cost_usd. */
  floor_usd: number;
  /** The Teacher turn that wrote this batch's rules. Part of floor_usd. */
  teacher_usd: number;
  /** One-off environment builds. Not part of cost_usd: a batch that builds the env is not a worse batch. */
  setup_usd: number;
  /** Calibration attempts on this batch's tasks. Part of cost_usd at the calibration gate only. */
  calibration_usd: number;
  /** Candidates the Scout submitted that a `skip_if` filter dropped before they became cards. */
  filtered: number;
  filtered_by: Record<string, number>;
  /** Rules the batch ran with (trial and kept), by id. */
  rules_served: string[];
  computed_at: number;
  /** The Teacher's turn after this batch: what it proposed. */
  teacher?: {
    state: 'skipped' | 'done' | 'failed';
    turn_id?: string | null;
    rules?: string[];
    summary?: string | null;
    note?: string | null;
  } | null;
}

export interface ReasonCount {
  count: number;
  decided: number;
}

/** A rule's measured effect: the batch before it against the batch that ran it. */
export interface MeasuredEffect {
  /** Change in accepted share, in percentage points. */
  accepted_share_pts?: number;
  /** Change in dollars per accepted task. */
  usd_per_accepted?: number;
  summary?: string;
  gate?: LearningGate;
  target_reason?: string;
  target_before?: ReasonCount;
  target_after?: ReasonCount;
  before?: BatchNumbers;
  after?: BatchNumbers;
  checks?: { target_dropped: boolean; share_improved: boolean; usd_improved: boolean };
  /** Candidates this filter dropped in the batch that ran it. */
  filtered?: number;
  /** Other rules on trial in the same batch: they share one measurement. */
  measured_with?: string[];
}
