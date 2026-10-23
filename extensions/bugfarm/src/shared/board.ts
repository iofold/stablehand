/**
 * The Bugfarm board model, shared by the worker and the web board.
 *
 * Every row is append-only: `(id, kind, key, content_sha, payload, created_at)`.
 * The current state of a thing is the latest row for its `(kind, key)`.
 * Payload field names are snake_case so pipelines in any language can write them.
 * Timestamps are epoch milliseconds.
 */

export const ROW_KINDS = ['campaign', 'batch', 'item', 'attempt', 'rule', 'cell'] as const;
export type RowKind = (typeof ROW_KINDS)[number];

/** Board columns, in order. `accepted`, `rejected` and `published` are terminal-ish. */
export const STAGES = [
  'mined',
  'env_ready',
  'fail_pass',
  'controls',
  'calibrating',
  'accepted',
  'rejected',
  'published',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  mined: 'Mined',
  env_ready: 'Env ready',
  fail_pass: 'Fails→Passes',
  controls: 'Controls ✓',
  calibrating: 'Calibrating',
  accepted: 'Accepted',
  rejected: 'Rejected',
  published: 'Published',
};

/** What each column means, in plain words (shown as the column's tooltip). */
export const STAGE_HINTS: Record<Stage, string> = {
  mined: 'Bug-fix commits picked from the history',
  env_ready: 'The repo builds and its test suite runs',
  fail_pass: 'Tests fail before the fix and pass after it',
  controls: 'The reference fix scores 1 and doing nothing scores 0',
  calibrating: 'Models from each family are trying to solve it',
  accepted: 'Hard enough to be useful, solvable enough to be fair',
  rejected: 'Dropped, with the reason',
  published: 'Approved and shipped as a task',
};

/** Known reasons for rejection. Pipelines may send others; the board shows them as-is. */
export const REJECT_REASONS: Record<string, string> = {
  env_build_failed: 'Env build failed',
  no_fail_to_pass: 'No failing test',
  flaky: 'Flaky tests',
  reverse_patch_conflict: 'Patch conflict',
  oracle_failed: 'Fix fails its own tests',
  nop_passed: 'Passes without a fix',
  instruction_leaks_fix: 'Instruction leaks the fix',
  too_easy: 'Too easy',
  unsolved_broken: 'Unsolvable',
  out_of_band: 'Out of band',
  over_budget: 'Over budget',
};

export function rejectReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Rejected';
  return REJECT_REASONS[reason] ?? reason.replace(/_/g, ' ');
}

export type AttemptResult = 'pass' | 'fail' | 'error';

export interface PassCount {
  passes: number;
  attempts: number;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface CampaignPayload {
  name?: string;
  repo?: string;
  cap_usd?: number;
  spend_usd?: number;
  started_at?: number;
  unattended_since?: number | null;
  recovered_from_crash?: number;
  batch?: number;
  status?: 'running' | 'paused' | 'recovering' | 'done';
  approval?: {
    state: 'waiting' | 'approved' | 'rejected' | 'timeout' | 'suspend';
    interrupt_id?: string;
    tool?: string;
    requested_at?: number;
    resolved_at?: number;
  } | null;
  budget_alert?: {
    action: string;
    threshold: number;
    spent: number;
    limit: number;
    at: number;
  } | null;
  floor?: {
    last_event_at?: number;
    last_event_type?: string;
    agents?: Record<string, { state: string; last_seen_at: number; turn_id?: string }>;
  };
  simulated?: boolean;
  [extra: string]: unknown;
}

export interface BatchPayload {
  n: number;
  candidates?: number;
  accepted?: number;
  rejected?: number;
  cost_usd?: number;
  accepted_share?: number;
  started_at?: number;
  finished_at?: number | null;
  status?: 'running' | 'done';
  simulated?: boolean;
  [extra: string]: unknown;
}

export interface ItemPayload {
  stage: Stage;
  reject_reason?: string | null;
  reject_detail?: string | null;
  repo?: string;
  sha?: string;
  title?: string;
  url?: string;
  batch?: number;
  diff?: string;
  diff_stats?: DiffStats;
  failing_tests?: string[];
  failing_output?: string;
  /** Pass counts per model family, e.g. `{ anthropic: { passes: 3, attempts: 8 } }`. */
  difficulty?: Record<string, PassCount>;
  cost_usd?: number;
  /** When the item entered each stage. The worker stamps a stage it sees for the first time. */
  stage_times?: Partial<Record<Stage, number>>;
  simulated?: boolean;
  [extra: string]: unknown;
}

export interface AttemptPayload {
  item: string;
  harness: string;
  model: string;
  family?: string;
  try: number;
  result: AttemptResult;
  cost_usd?: number;
  seconds?: number;
  phase?: 'calibration' | 'benchmark' | string;
  at?: number;
  simulated?: boolean;
  [extra: string]: unknown;
}

export interface RulePayload {
  text: string;
  kind?: string;
  batch_introduced: number;
  measured_batch?: number | null;
  status?: 'trial' | 'kept' | 'reverted';
  effect?: {
    /** Change in accepted share, in percentage points. */
    accepted_share_pts?: number;
    /** Change in dollars per accepted task. */
    usd_per_accepted?: number;
    summary?: string;
  } | null;
  simulated?: boolean;
  [extra: string]: unknown;
}

export interface CellPayload {
  harness: string;
  model: string;
  family?: string;
  solved: number;
  attempts: number;
  tasks?: number;
  pass_at_1: number;
  ci_low?: number;
  ci_high?: number;
  usd_per_solve?: number | null;
  cost_usd?: number;
  simulated?: boolean;
  [extra: string]: unknown;
}

export interface PayloadByKind {
  campaign: CampaignPayload;
  batch: BatchPayload;
  item: ItemPayload;
  attempt: AttemptPayload;
  rule: RulePayload;
  cell: CellPayload;
}

export interface BoardRow<K extends RowKind = RowKind> {
  id: number;
  kind: K;
  key: string;
  content_sha: string;
  payload: PayloadByKind[K];
  created_at: number;
}

export interface StateResponse {
  epoch: string;
  cursor: number;
  rows: BoardRow[];
}

export interface ChangesResponse {
  epoch: string;
  cursor: number;
  rows: BoardRow[];
  more: boolean;
}

/** Model family from a model id, for the difficulty dots and the attempts grid. */
export function modelFamily(model: string): string {
  const id = model.toLowerCase();
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (/(^|[/_-])(gpt|o\d|codex|openai)/.test(id)) return 'openai';
  if (id.includes('gemini') || id.includes('google')) return 'google';
  return 'open';
}

export const FAMILY_LABELS: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'GPT',
  google: 'Gemini',
  open: 'Open weights',
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}
