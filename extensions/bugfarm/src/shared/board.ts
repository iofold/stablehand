import type { MeasuredEffect } from './learning.js';
import type { Predicate } from './predicate.js';

/**
 * The Bugfarm board model, shared by the worker and the web board.
 *
 * Every row is append-only: `(id, kind, key, content_sha, payload, created_at)`.
 * The current state of a thing is the latest row for its `(kind, key)`.
 * Payload field names are snake_case so pipelines in any language can write them.
 * Timestamps are epoch milliseconds.
 */

/**
 * `job`, `turn` and `env` are the worker's own bookkeeping (pipeline jobs, the floor agents' turns
 * and each repo's environment). They live in the same store so a restarted worker resumes from
 * them; the board ignores them except for receipts.
 */
export const ROW_KINDS = ['campaign', 'batch', 'item', 'attempt', 'rule', 'cell', 'job', 'turn', 'env'] as const;
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
  oracle_failed: 'Reference fix fails',
  nop_passed: 'Passes without a fix',
  instruction_leaks_fix: 'Leaks the fix',
  too_easy: 'Too easy',
  unsolved_broken: 'Unsolvable',
  out_of_band: 'Wrong difficulty',
  over_budget: 'Over budget',
  no_test_targets: 'No test to run',
  import_error_only: 'Fails only at import',
  timeout: 'Tests too slow',
  check_error: 'Check crashed',
  control_error: 'Controls crashed',
  out_of_scope: 'Out of scope',
  too_large: 'Fix too large',
  not_found: 'Commit not found',
  writer_failed: 'No instruction',
  package_error: 'Packaging failed',
  env_drift: 'Deps moved on',
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
  /** Set when the campaign stops, for example at its cap. */
  finished_at?: number | null;
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
  /** Campaign the item belongs to; the board shows the current campaign's items. */
  campaign?: string;
  /** What is happening to the card right now, in plain words ("Writer is drafting the issue"). */
  activity?: string | null;
  /** The issue-style instruction the Writer produced. */
  instruction?: string;
  /** Pull request and closed issue the fix came from. */
  pr?: number | null;
  issue?: number | null;
  /** When the fix was committed; decontamination filters on it. */
  fix_date?: string;
  simulated?: boolean;
  [extra: string]: unknown;
}

export type JobKind = 'build_env' | 'check_candidate' | 'package_task' | 'run_controls';
export const JOB_KINDS: readonly JobKind[] = ['build_env', 'check_candidate', 'package_task', 'run_controls'];
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** A pipeline job. Started by the foreman or by a floor agent's `start_job` tool. */
export interface JobPayload {
  kind: JobKind;
  status: JobStatus;
  args: Record<string, unknown>;
  progress?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  owner?: 'foreman' | 'agent';
  campaign?: string | null;
  item?: string | null;
  turn_id?: string | null;
  /** How many times the job has been started; above 1 means a restart resumed it. */
  runs?: number;
  created_at?: number;
  started_at?: number | null;
  finished_at?: number | null;
  [extra: string]: unknown;
}

export type FloorRole = 'scout' | 'env_builder' | 'writer' | 'teacher';

/** A floor agent's Stablehand turn, keyed by turn id. Tools find their item through it. */
export interface TurnPayload {
  turn_id: string;
  role: FloorRole;
  agent_id: string;
  campaign: string;
  batch: number;
  /** The tag `stage`: scout, env, write, review, teach. */
  stage: string;
  /** The tag `item`: the item key, or a batch or repo key for turns that are not about one item. */
  item: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  error?: string | null;
  cost_usd?: number | null;
  cost_coverage?: string | null;
  /** The latest thing the agent submitted through a tool (candidates, an instruction). */
  submission?: Record<string, unknown> | null;
  submissions?: number;
  started_at?: number;
  finished_at?: number | null;
  [extra: string]: unknown;
}

/** A repo's environment image, keyed by repo. The checks run on it. */
export interface EnvPayload {
  repo: string;
  head: string;
  tag: string;
  ok: boolean;
  dockerfile: string;
  reason?: string | null;
  collected_tests?: number;
  job_id?: string | null;
  built_by?: 'agent' | 'profile';
  built_at?: number;
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
  /** Measured by the learning loop; the simulator writes only the first three fields. */
  effect?: MeasuredEffect | null;
  /** Limits the rule to one repository (`owner/name`). */
  repo?: string;
  /** The campaign that introduced it; its batches measure it. */
  campaign?: string;
  /** `starter`, `hand` or `teacher`. */
  source?: string;
  /** Scout filters: the candidates the worker drops, as a predicate over their features. */
  skip_if?: Predicate | null;
  /** The rejection reason the rule is meant to reduce, and what its author expected. */
  targets?: string | null;
  expected_effect?: string | null;
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
  /** The benchmark run this row belongs to (`bench/`); the leaderboard shows one run at a time. */
  bench?: string;
  campaign?: string;
  repo?: string;
  /** Who ran the trials, in plain words: "Stablehand claude-agents", "Harbor terminus-2". */
  runner?: string;
  k?: number;
  planned_attempts?: number;
  running?: number;
  tasks_planned?: number;
  tasks_solved?: number;
  errors?: number;
  median_seconds?: number | null;
  notes?: string[];
  task_set?: { kind: 'accepted' | 'dev_standin' | string; label: string; note?: string | null };
  updated_at?: number;
  [extra: string]: unknown;
}

export interface PayloadByKind {
  campaign: CampaignPayload;
  batch: BatchPayload;
  item: ItemPayload;
  attempt: AttemptPayload;
  rule: RulePayload;
  cell: CellPayload;
  job: JobPayload;
  turn: TurnPayload;
  env: EnvPayload;
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
