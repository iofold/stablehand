import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { FloorApi } from './floor/api.js';
import { leakInputFor, type ItemContext } from './foreman/context.js';
import { parseCandidates } from './foreman/foreman.js';
import { jobIdFor, type JobRecord, type JobRunner } from './jobs/runner.js';
import type { LearningLoop } from './learning/loop.js';
import { checkLeaks } from './leak-check.js';
import type { BoardRow, FloorRole, ItemPayload, JobKind, TurnPayload } from './shared/board.js';
import type { UpsertInput } from './store/validate.js';

/**
 * The floor agents' HTTP tools. Stablehand calls these from the orchestrator (never from a
 * sandbox) with the bearer secret the agent holds as a tools-scope secret, and adds `X-Turn-Id`,
 * which is how a submission finds its card.
 *
 *   POST /tools/v1/start_job          {kind, args}             → {job_id, status}
 *   POST /tools/v1/job_status         {job_id, wait_seconds?}  → {status, progress, result}
 *   POST /tools/v1/submit_candidates  {candidates: [...]}      Scout
 *   POST /tools/v1/submit_instruction {instruction}            Writer; answers with a leak report
 *   POST /tools/v1/propose_rules      {summary, rules: [...]}  Teacher; answers with a check of each rule
 */

export class ToolError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ToolDeps {
  jobs: Pick<JobRunner, 'submit' | 'get' | 'wait'>;
  store: {
    latest(kind: 'turn' | 'item', key: string): Promise<BoardRow | null>;
    upsert(rows: UpsertInput[]): Promise<unknown>;
  };
  floor: Pick<FloorApi, 'lookupTurn'> | null;
  itemContext: (repo: string, sha: string) => ItemContext;
  /** The learning loop: Scout filters on submit_candidates, and propose_rules. */
  learning?: Pick<LearningLoop, 'screen' | 'review'> | null;
}

/** Sandbox tool calls time out at 5 minutes; a long poll stays well inside that. */
export const MAX_WAIT_SECONDS = 240;

const Repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must look like owner/name');
const Sha = z.string().regex(/^[0-9a-f]{7,40}$/, 'sha must be a hex commit id');

const JOB_ARGS: Record<JobKind, z.ZodType<Record<string, unknown>>> = {
  build_env: z.object({ repo: Repo, dockerfile: z.string().min(20).max(50_000) }),
  check_candidate: z.object({ repo: Repo, sha: Sha, pr: z.number().int().positive().optional() }),
  package_task: z.object({
    repo: Repo,
    sha: Sha,
    instruction: z.string().min(40).max(20_000),
    pr: z.number().int().positive().optional(),
    issue: z.number().int().positive().optional(),
    url: z.string().max(500).optional(),
  }),
  run_controls: z.object({ repo: Repo, sha: Sha }),
};

const StartJob = z.object({ kind: z.enum(['build_env', 'check_candidate', 'package_task', 'run_controls']), args: z.record(z.string(), z.unknown()) });
const JobStatus = z.object({ job_id: z.string().min(1).max(200), wait_seconds: z.number().min(0).optional() });
const SubmitCandidates = z.object({ candidates: z.array(z.unknown()).min(1).max(60) });
const SubmitInstruction = z.object({ instruction: z.string().min(40).max(20_000) });

function issues(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const ROLE_BY_STAGE: Record<string, FloorRole> = { scout: 'scout', env: 'env_builder', write: 'writer', review: 'writer', teach: 'teacher' };

/** A compact view of a job for an agent: enough to act on, nothing it cannot use. */
export function jobView(job: JobRecord): Record<string, unknown> {
  const done = job.status === 'done' || job.status === 'failed';
  return {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress ?? null,
    ...(job.status === 'done' ? { result: job.result } : {}),
    ...(job.status === 'failed' ? { error: (job.error ?? '').slice(-3000) } : {}),
    ...(done ? {} : { next: `Call job_status with {"job_id": "${job.id}", "wait_seconds": ${MAX_WAIT_SECONDS}}.` }),
  };
}

export function createToolHandlers(deps: ToolDeps) {
  async function turnOf(req: IncomingMessage): Promise<(TurnPayload & { key: string }) | null> {
    const turnId = header(req, 'x-turn-id');
    if (!turnId) return null;
    const row = await deps.store.latest('turn', turnId);
    if (row) return { ...(row.payload as TurnPayload), key: row.key };
    if (!deps.floor) return null;
    // The foreman writes the turn row right after starting it; a call that beats it (or lands
    // while a restarted foreman catches up) is matched through the turn's own tags.
    const info = await deps.floor.lookupTurn(turnId);
    const role = ROLE_BY_STAGE[info.tags.stage ?? ''];
    if (!role || !info.tags.item) return null;
    const payload: TurnPayload = {
      turn_id: turnId,
      role,
      agent_id: info.agentId,
      campaign: info.tags.item.split(':')[0] ?? 'unknown',
      batch: Number(info.tags.batch ?? '1') || 1,
      stage: info.tags.stage,
      item: info.tags.item,
      status: 'running',
      started_at: Date.now(),
    };
    await deps.store.upsert([{ kind: 'turn', key: turnId, payload: payload as Record<string, unknown> }]);
    return { ...payload, key: turnId };
  }

  async function startJob(body: unknown, req: IncomingMessage): Promise<Record<string, unknown>> {
    const parsed = StartJob.safeParse(body);
    if (!parsed.success) throw new ToolError(400, `start_job: ${issues(parsed.error)}. kind is one of build_env, check_candidate, package_task, run_controls.`);
    const { kind } = parsed.data;
    const args = JOB_ARGS[kind].safeParse(parsed.data.args);
    if (!args.success) throw new ToolError(400, `start_job ${kind}: ${issues(args.error)}`);
    const turn = await turnOf(req);
    const job = await deps.jobs.submit(kind, args.data, {
      id: jobIdFor(kind, args.data),
      owner: 'agent',
      turnId: turn?.turn_id ?? header(req, 'x-turn-id'),
      campaign: turn?.campaign ?? null,
      item: turn?.item ?? null,
    });
    return jobView(job);
  }

  async function jobStatus(body: unknown): Promise<Record<string, unknown>> {
    const parsed = JobStatus.safeParse(body);
    if (!parsed.success) throw new ToolError(400, `job_status: ${issues(parsed.error)}`);
    const waitMs = Math.min(parsed.data.wait_seconds ?? 0, MAX_WAIT_SECONDS) * 1000;
    const job = await deps.jobs.wait(parsed.data.job_id, waitMs);
    if (!job) throw new ToolError(404, `No job ${parsed.data.job_id}. Start one with start_job.`);
    return jobView(job);
  }

  async function submitCandidates(body: unknown, req: IncomingMessage): Promise<Record<string, unknown>> {
    const parsed = SubmitCandidates.safeParse(body);
    if (!parsed.success) throw new ToolError(400, `submit_candidates: ${issues(parsed.error)}`);
    const turn = await turnOf(req);
    if (!turn || turn.role !== 'scout') throw new ToolError(409, 'submit_candidates only works inside a Bugfarm Scout turn.');
    const parsedCandidates = parseCandidates({ candidates: parsed.data.candidates });
    const dropped = parsed.data.candidates.length - parsedCandidates.length;
    if (parsedCandidates.length === 0) {
      throw new ToolError(422, 'None of the candidates had both a PR number (pr) and a merge commit sha (sha, 7-40 hex characters). Fix them and submit again.');
    }
    // Scout filters with a skip_if predicate are code: the worker drops what they match.
    const screen = deps.learning ? await deps.learning.screen(turn, parsedCandidates, parsed.data.candidates) : null;
    const candidates = screen?.kept ?? parsedCandidates;
    const skipped = screen?.skipped ?? [];
    await deps.store.upsert([{
      kind: 'turn',
      key: turn.key,
      payload: {
        submission: { candidates, at: Date.now(), ...(screen ? { skipped, extras: screen.extras, features: screen.features } : {}) },
        submissions: (turn.submissions ?? 0) + 1,
      },
    }]);
    const notes: string[] = [];
    if (dropped > 0) notes.push(`${dropped} had no valid pr or sha and were dropped`);
    if (skipped.length > 0) {
      notes.push(`the playbook's filters dropped ${skipped.length}: ${skipped.map((s) => `#${s.pr} (${s.rule}: ${s.predicate})`).join('; ')}`);
    }
    return {
      accepted: candidates.length,
      dropped,
      skipped: skipped.map((s) => ({ pr: s.pr, rule: s.rule, skip_if: s.predicate })),
      message: notes.length > 0
        ? `Recorded ${candidates.length} candidates; ${notes.join('; ')}. To fill the batch, submit the full list again (kept ones plus replacements); the last submission counts.`
        : `Recorded ${candidates.length} candidates. You are done; reply with a one-line summary.`,
    };
  }

  async function submitInstruction(body: unknown, req: IncomingMessage): Promise<Record<string, unknown>> {
    const parsed = SubmitInstruction.safeParse(body);
    if (!parsed.success) throw new ToolError(400, `submit_instruction: ${issues(parsed.error)}`);
    const turn = await turnOf(req);
    if (!turn || turn.role !== 'writer') throw new ToolError(409, 'submit_instruction only works inside a Bugfarm Writer turn.');
    const itemRow = await deps.store.latest('item', turn.item);
    const item = itemRow?.payload as ItemPayload | undefined;
    if (!item?.repo || !item.sha) throw new ToolError(409, `This turn's card (${turn.item}) has no checked commit yet.`);
    const instruction = parsed.data.instruction.trim();
    const report = checkLeaks(leakInputFor(deps.itemContext(item.repo, item.sha), instruction));
    await deps.store.upsert([{
      kind: 'turn',
      key: turn.key,
      payload: { submission: { instruction, clean: report.clean, leaks: report.leaks, at: Date.now() }, submissions: (turn.submissions ?? 0) + 1 },
    }]);
    return report.clean
      ? { clean: true, leaks: [], message: 'Recorded. No leaks found. You are done; reply with a one-line summary.' }
      : {
        clean: false,
        leaks: report.leaks,
        message: 'Recorded, but it gives the fix away (see leaks). Rewrite those parts as symptoms a user would see and call submit_instruction again with the full text.',
      };
  }

  async function proposeRules(body: unknown, req: IncomingMessage): Promise<Record<string, unknown>> {
    const turn = await turnOf(req);
    if (!turn || turn.role !== 'teacher') throw new ToolError(409, 'propose_rules only works inside a Bugfarm Teacher turn.');
    if (!deps.learning) throw new ToolError(503, 'The learning loop is off on this worker.');
    let review: Awaited<ReturnType<LearningLoop['review']>>;
    try {
      review = await deps.learning.review(turn, body);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number') throw new ToolError(status, (err as Error).message);
      throw err;
    }
    await deps.store.upsert([{
      kind: 'turn',
      key: turn.key,
      payload: { submission: { summary: review.summary, rules: review.rules, reports: review.reports, at: Date.now() }, submissions: (turn.submissions ?? 0) + 1 },
    }]);
    return {
      recorded: review.rules.length,
      reports: review.reports.map((report) => ({
        index: report.index,
        ok: report.ok,
        ...(report.errors.length > 0 ? { errors: report.errors } : {}),
        ...(report.warnings.length > 0 ? { warnings: report.warnings } : {}),
        ...(report.predicate ? { skip_if: report.predicate } : {}),
        ...(report.dry_run ? { dry_run: report.dry_run } : {}),
      })),
      message: review.message,
    };
  }

  return {
    async handle(name: string, body: unknown, req: IncomingMessage): Promise<Record<string, unknown>> {
      switch (name) {
        case 'start_job':
          return startJob(body, req);
        case 'job_status':
          return jobStatus(body);
        case 'submit_candidates':
          return submitCandidates(body, req);
        case 'submit_instruction':
          return submitInstruction(body, req);
        case 'propose_rules':
          return proposeRules(body, req);
        default:
          throw new ToolError(404, `no tool ${name}`);
      }
    },
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
