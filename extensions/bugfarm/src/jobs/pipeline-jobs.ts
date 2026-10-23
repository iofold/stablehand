import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEnv } from '../../pipeline/lib/build-env.ts';
import type { EnvBuildResult } from '../../pipeline/lib/build-env.ts';
import { checkCandidate } from '../../pipeline/lib/check-candidate.ts';
import type { CheckResult } from '../../pipeline/lib/check-candidate.ts';
import { RESULTS_DIR, TASKS_DIR } from '../../pipeline/lib/config.ts';
import { judgeControls, runHarborAgent } from '../../pipeline/lib/controls.ts';
import { packageTask } from '../../pipeline/lib/package-task.ts';
import { profileFor } from '../../pipeline/lib/repos.ts';
import { candidateFromUnit } from '../../pipeline/lib/scout.ts';
import type { Candidate } from '../../pipeline/lib/scout.ts';
import type { BoardRow, EnvPayload, JobKind } from '../shared/board.js';
import type { UpsertInput } from '../store/validate.js';
import type { JobContext, JobHandler } from './runner.js';

/**
 * The four pipeline steps as job handlers. Each one is safe to run again from the top after a
 * restart: trees are rebuilt, images and clones are reused.
 */

const TARGET_TIMEOUT_MS = 5 * 60_000;
const SUBSET_TIMEOUT_MS = 5 * 60_000;
const LOG_TAIL_CHARS = 6000;

export interface PipelineStore {
  upsert(rows: UpsertInput[]): Promise<unknown>;
  latest(kind: 'env', key: string): Promise<BoardRow | null>;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`args.${key} is required`);
  return value.trim();
}

function optionalNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tail(text: string, chars = LOG_TAIL_CHARS): string {
  return text.length > chars ? `[...]\n${text.slice(-chars)}` : text;
}

export function checkFile(repo: string, sha: string): string {
  return join(RESULTS_DIR, profileFor(repo).slug, 'checks', `${sha.slice(0, 12)}.json`);
}

export function readCheck(repo: string, sha: string): CheckResult {
  return JSON.parse(readFileSync(checkFile(repo, sha), 'utf8')) as CheckResult;
}

/** The repo's current env as the pipeline expects it, or null when none has been built. */
export async function envFor(store: PipelineStore, repo: string): Promise<EnvBuildResult | null> {
  const row = await store.latest('env', repo);
  if (!row) return null;
  const env = row.payload as EnvPayload;
  return {
    repo,
    head: env.head,
    tag: env.tag,
    ok: env.ok,
    reason: env.reason ?? undefined,
    build_seconds: 0,
    size_bytes: 0,
    reused: true,
    collected_tests: env.collected_tests ?? 0,
    collection_errors: [],
    collect_seconds: 0,
    logs_path: '',
    dockerfile: env.dockerfile,
  };
}

async function resolveCandidate(repo: string, sha: string, pr: number | null): Promise<{ ok: true; candidate: Candidate } | { ok: false; reason: string; detail: string }> {
  return candidateFromUnit(repo, sha, pr ? { pr } : {});
}

export function createPipelineHandlers(deps: { store: PipelineStore; logger?: Pick<Console, 'log'> }): Record<JobKind, JobHandler> {
  const { store } = deps;

  const buildEnvJob: JobHandler = async (ctx: JobContext) => {
    const repo = str(ctx.args, 'repo');
    const dockerfile = typeof ctx.args.dockerfile === 'string' && ctx.args.dockerfile.trim() ? ctx.args.dockerfile : undefined;
    await ctx.progress(dockerfile ? 'Building the image from the submitted Dockerfile' : 'Building the image from the repo profile');
    const env = await buildEnv(repo, { dockerfileText: dockerfile });
    const logs = existsText(env.logs_path);
    if (env.ok) {
      const payload: EnvPayload = {
        repo,
        head: env.head,
        tag: env.tag,
        ok: true,
        dockerfile: env.dockerfile,
        reason: null,
        collected_tests: env.collected_tests,
        job_id: ctx.id,
        built_by: dockerfile ? 'agent' : 'profile',
        built_at: Date.now(),
      };
      await store.upsert([{ kind: 'env', key: repo, payload: payload as Record<string, unknown>, mode: 'replace' }]);
    }
    return {
      ok: env.ok,
      reason: env.reason ?? null,
      repo,
      head: env.head,
      tag: env.tag,
      collected_tests: env.collected_tests,
      collection_errors: env.collection_errors.slice(0, 20),
      build_seconds: env.build_seconds,
      reused_image: env.reused,
      logs_tail: tail(logs),
    };
  };

  const checkJob: JobHandler = async (ctx) => {
    const repo = str(ctx.args, 'repo');
    const sha = str(ctx.args, 'sha');
    await ctx.progress('Reading the fix from git history');
    const unit = await resolveCandidate(repo, sha, optionalNumber(ctx.args, 'pr'));
    if (!unit.ok) return { accepted: false, reason: unit.reason, detail: unit.detail };
    const env = await envFor(store, repo);
    if (!env?.ok) return { accepted: false, reason: 'env_build_failed', detail: env?.reason ?? 'no environment has been built for this repo' };
    const check = await checkCandidate(unit.candidate, env, {
      targetTimeoutMs: TARGET_TIMEOUT_MS,
      subsetTimeoutMs: SUBSET_TIMEOUT_MS,
      onProgress: (message) => void ctx.progress(message),
    });
    return {
      accepted: check.accepted,
      reason: check.reason ?? null,
      detail: check.detail?.slice(0, 1500) ?? null,
      sha: unit.candidate.sha,
      subject: unit.candidate.subject,
      fix_date: unit.candidate.date,
      buggy_base: check.buggy_base ?? null,
      fail_to_pass: check.fail_to_pass,
      pass_to_pass_count: check.pass_to_pass.length,
      suite_modules: check.suite_modules,
      source_files: unit.candidate.source_files,
      test_files: unit.candidate.test_files,
      non_test_lines: unit.candidate.non_test_lines,
      check_file: checkFile(repo, unit.candidate.sha),
      seconds: check.timings.total_seconds ?? null,
    };
  };

  const packageJob: JobHandler = async (ctx) => {
    const repo = str(ctx.args, 'repo');
    const sha = str(ctx.args, 'sha');
    const instruction = typeof ctx.args.instruction === 'string' ? ctx.args.instruction : undefined;
    const check = readCheck(repo, sha);
    if (!check.accepted) throw new Error(`the check for ${sha.slice(0, 12)} did not pass (${check.reason ?? 'unknown'}); nothing to package`);
    const unit = await resolveCandidate(repo, check.sha, optionalNumber(ctx.args, 'pr'));
    if (!unit.ok) throw new Error(`${unit.reason}: ${unit.detail}`);
    await ctx.progress('Writing the Harbor task');
    const task = await packageTask(check, unit.candidate, {
      instruction,
      pr: optionalNumber(ctx.args, 'pr'),
      issue: optionalNumber(ctx.args, 'issue'),
      url: typeof ctx.args.url === 'string' ? ctx.args.url : null,
    });
    const rowsDir = join(RESULTS_DIR, profileFor(repo).slug, 'swebench');
    mkdirSync(rowsDir, { recursive: true });
    writeFileSync(join(rowsDir, `${task.dirName}.json`), `${JSON.stringify(task.swebench)}\n`);
    return { task_dir: task.dir, task_name: task.name, dir_name: task.dirName, fail_to_pass: task.fail_to_pass, pass_to_pass: task.pass_to_pass };
  };

  const controlsJob: JobHandler = async (ctx) => {
    const repo = str(ctx.args, 'repo');
    const sha = str(ctx.args, 'sha');
    const slug = profileFor(repo).slug;
    const dirName = `${slug}-${sha.slice(0, 10)}`;
    const datasetDir = join(TASKS_DIR, slug);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    await ctx.progress('Running the reference fix (must score 1) and doing nothing (must score 0)');
    const [oracle, nop] = await Promise.all([
      runHarborAgent(datasetDir, 'oracle', { jobName: `${dirName}-oracle-${stamp}`, tasks: [dirName], concurrency: 1, timeoutMs: 45 * 60_000 }),
      runHarborAgent(datasetDir, 'nop', { jobName: `${dirName}-nop-${stamp}`, tasks: [dirName], concurrency: 1, timeoutMs: 45 * 60_000 }),
    ]);
    const [verdict] = judgeControls(oracle.trials, nop.trials, [dirName]);
    return {
      passed: verdict.passed,
      reason: verdict.reason ?? null,
      detail: verdict.detail ?? null,
      oracle: verdict.oracle,
      nop: verdict.nop,
      oracle_seconds: oracle.trials[0]?.seconds ?? null,
      nop_seconds: nop.trials[0]?.seconds ?? null,
      task: dirName,
    };
  };

  return {
    build_env: buildEnvJob,
    check_candidate: checkJob,
    package_task: packageJob,
    run_controls: controlsJob,
  };
}

function existsText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
