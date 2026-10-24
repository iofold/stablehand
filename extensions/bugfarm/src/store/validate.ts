import { z } from 'zod';
import { JOB_KINDS, ROW_KINDS, STAGES, type JobKind, type RowKind } from '../shared/board.js';

/** Epoch milliseconds, or an ISO-8601 string that is converted to them. */
const Millis = z.union([
  z.number().nonnegative(),
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'expected epoch ms or an ISO-8601 time')
    .transform((value) => Date.parse(value)),
]);

const Usd = z.number().nonnegative();
const Count = z.number().int().nonnegative();
const Share = z.number().min(0).max(1);

const PassCount = z.object({ passes: Count, attempts: Count });

const Campaign = z.looseObject({
  name: z.string().optional(),
  repo: z.string().optional(),
  cap_usd: Usd.optional(),
  spend_usd: Usd.optional(),
  started_at: Millis.optional(),
  unattended_since: Millis.nullable().optional(),
  recovered_from_crash: Count.optional(),
  batch: Count.optional(),
  status: z.enum(['running', 'paused', 'recovering', 'done']).optional(),
  finished_at: Millis.nullable().optional(),
  simulated: z.boolean().optional(),
});

const Batch = z.looseObject({
  n: Count,
  candidates: Count.optional(),
  accepted: Count.optional(),
  rejected: Count.optional(),
  cost_usd: Usd.optional(),
  accepted_share: Share.optional(),
  started_at: Millis.optional(),
  finished_at: Millis.nullable().optional(),
  status: z.enum(['running', 'done']).optional(),
  simulated: z.boolean().optional(),
});

const Item = z.looseObject({
  stage: z.enum(STAGES),
  reject_reason: z.string().max(80).nullable().optional(),
  reject_detail: z.string().max(2000).nullable().optional(),
  repo: z.string().max(200).optional(),
  sha: z.string().max(64).optional(),
  title: z.string().max(400).optional(),
  url: z.string().max(1000).optional(),
  batch: Count.optional(),
  diff: z.string().max(400_000).optional(),
  diff_stats: z.object({ files: Count, additions: Count, deletions: Count }).optional(),
  failing_tests: z.array(z.string().max(500)).max(500).optional(),
  failing_output: z.string().max(100_000).optional(),
  difficulty: z.record(z.string(), PassCount).optional(),
  cost_usd: Usd.optional(),
  stage_times: z.partialRecord(z.enum(STAGES), Millis).optional(),
  simulated: z.boolean().optional(),
});

const Attempt = z.looseObject({
  item: z.string().min(1),
  harness: z.string().min(1),
  model: z.string().min(1),
  family: z.string().optional(),
  try: z.number().int().positive(),
  result: z.enum(['pass', 'fail', 'error']),
  cost_usd: Usd.optional(),
  seconds: z.number().nonnegative().optional(),
  phase: z.string().optional(),
  at: Millis.optional(),
  simulated: z.boolean().optional(),
});

const Rule = z.looseObject({
  text: z.string().min(1).max(2000),
  kind: z.string().optional(),
  batch_introduced: Count,
  measured_batch: Count.nullable().optional(),
  status: z.enum(['trial', 'kept', 'reverted']).optional(),
  effect: z.looseObject({
    accepted_share_pts: z.number().optional(),
    usd_per_accepted: z.number().optional(),
    summary: z.string().optional(),
  }).nullable().optional(),
  simulated: z.boolean().optional(),
});

const Cell = z.looseObject({
  harness: z.string().min(1),
  model: z.string().min(1),
  family: z.string().optional(),
  solved: Count,
  attempts: Count,
  tasks: Count.optional(),
  pass_at_1: Share,
  ci_low: Share.optional(),
  ci_high: Share.optional(),
  usd_per_solve: Usd.nullable().optional(),
  cost_usd: Usd.optional(),
  simulated: z.boolean().optional(),
});

const Job = z.looseObject({
  kind: z.enum(JOB_KINDS as [JobKind, ...JobKind[]]),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  args: z.record(z.string(), z.unknown()),
  progress: z.string().max(2000).nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().max(8000).nullable().optional(),
  owner: z.enum(['foreman', 'agent']).optional(),
  runs: Count.optional(),
  created_at: Millis.optional(),
  started_at: Millis.nullable().optional(),
  finished_at: Millis.nullable().optional(),
});

const Turn = z.looseObject({
  turn_id: z.string().min(1),
  role: z.enum(['scout', 'env_builder', 'writer', 'teacher']),
  agent_id: z.string().min(1),
  campaign: z.string().min(1),
  batch: Count,
  stage: z.string().min(1),
  item: z.string().min(1),
  status: z.enum(['running', 'completed', 'error', 'cancelled']),
  cost_usd: Usd.nullable().optional(),
  started_at: Millis.optional(),
  finished_at: Millis.nullable().optional(),
});

const Env = z.looseObject({
  repo: z.string().min(1),
  head: z.string().min(1),
  tag: z.string().min(1),
  ok: z.boolean(),
  dockerfile: z.string().max(100_000),
  built_at: Millis.optional(),
});

export const PAYLOAD_SCHEMAS: Record<RowKind, z.ZodType<Record<string, unknown>>> = {
  campaign: Campaign,
  batch: Batch,
  item: Item,
  attempt: Attempt,
  rule: Rule,
  cell: Cell,
  job: Job,
  turn: Turn,
  env: Env,
};

export const RowKey = z.string().min(1).max(200).regex(/^[^\u0000-\u001f]+$/, 'key must not contain control characters');

export const UpsertInputSchema = z.strictObject({
  kind: z.enum(ROW_KINDS),
  key: RowKey,
  payload: z.record(z.string(), z.unknown()),
  /** `merge` (default) deep-merges into the latest payload; `replace` writes it as given. */
  mode: z.enum(['merge', 'replace']).optional(),
});
export type UpsertInput = z.infer<typeof UpsertInputSchema>;

export const UpsertBodySchema = z.strictObject({
  rows: z.array(UpsertInputSchema).min(1).max(500),
});

/** Validate one merged payload. Returns the parsed payload or a readable error. */
export function validatePayload(
  kind: RowKind,
  payload: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const result = PAYLOAD_SCHEMAS[kind].safeParse(payload);
  if (result.success) return { ok: true, payload: result.data };
  return { ok: false, error: formatIssues(result.error) };
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}
