// One solver attempt: Harbor 0.24's terminus-2 on one task, through the Stablehand gateway.
//
// terminus-2 runs on the host and drives the task container over tmux, so the container keeps
// `network_mode: none`. Its model calls go through LiteLLM's OpenAI-compatible client: the model
// is `openai/<gateway model>`, `api_base` is the gateway's /v1, and the key comes from
// OPENAI_API_KEY in Harbor's own environment (never in the job config, which Harbor writes to disk).
// Each call carries `x-litellm-spend-logs-metadata` with the attempt id, so the gateway's spend log
// prices every attempt exactly.
//
// One Harbor job per attempt: the attempt id has to differ per trial, and agent kwargs are per job.
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARBOR_CMD } from './lib/config.ts';
import { cleanupHarborProjects } from './lib/docker.ts';
import { ensureDir, fileExists, isDir, log, readJson, run, secs, writeText } from './lib/util.ts';
import { toAtifV17 } from './calibrate-atif.ts';
import type { AttemptResult } from './calibrate-ladder.ts';

export interface ModelPricing {
  /** USD per token. */
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface SolverModel {
  /** Gateway model name, e.g. `claude-haiku-4-5`. */
  model: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  /** The gateway's prices, so Harbor's own cost estimate matches the gateway's bill. */
  pricing: ModelPricing;
  /** Extra kwargs for every LLM call of this model (merged under the spend-log header). */
  call_kwargs?: Record<string, unknown>;
}

export interface AttemptSpec {
  attemptId: string;
  taskDir: string;
  jobsDir: string;
  jobName: string;
  model: SolverModel;
  /** terminus-2 options shared by the whole panel (part of its frozen identity). */
  agentKwargs: Record<string, unknown>;
  /** Overrides the task's agent timeout, in seconds (also frozen with the panel). */
  agentTimeoutSec?: number;
  gatewayUrl: string;
  gatewayKey: string;
  /** Extra spend-log metadata stamped on every call. */
  spendMetadata?: Record<string, string>;
  /** Hard wall-clock limit for the whole Harbor process. */
  processTimeoutMs: number;
}

export interface AttemptOutcome {
  result: AttemptResult;
  reward: number | null;
  exception?: string;
  seconds: number;
  agent_seconds?: number;
  verifier_seconds?: number;
  cost_usd_estimate?: number;
  llm_calls?: number;
  episodes?: number;
  n_input_tokens?: number;
  n_cache_tokens?: number;
  n_output_tokens?: number;
  job_dir: string;
  trial_dir?: string;
  /** Raw ATIF trajectories as Harbor wrote them (v1.8), copied next to the attempt record. */
  trajectories: string[];
  /** The same trajectories converted to ATIF v1.7. */
  trajectories_v17: string[];
  harbor_exit: number | null;
}

interface TrialResultJson {
  trial_name?: string;
  verifier_result?: { rewards?: Record<string, number> } | null;
  exception_info?: { exception_type?: string; exception_message?: string } | null;
  started_at?: string;
  finished_at?: string;
  agent_execution?: { started_at?: string; finished_at?: string } | null;
  verifier?: { started_at?: string; finished_at?: string } | null;
  agent_result?: {
    cost_usd?: number | null;
    n_input_tokens?: number | null;
    n_cache_tokens?: number | null;
    n_output_tokens?: number | null;
    metadata?: { n_episodes?: number; api_request_times_msec?: number[] } | null;
  } | null;
}

function span(t?: { started_at?: string; finished_at?: string } | null): number | undefined {
  if (!t?.started_at || !t.finished_at) return undefined;
  return secs(Date.parse(t.finished_at) - Date.parse(t.started_at));
}

/** Build the Harbor JobConfig for one attempt. Contains no secrets. */
export function jobConfig(spec: AttemptSpec): Record<string, unknown> {
  const m = spec.model;
  const modelInfo: Record<string, number> = {
    max_input_tokens: m.max_input_tokens,
    input_cost_per_token: m.pricing.input,
    output_cost_per_token: m.pricing.output,
  };
  if (m.max_output_tokens) modelInfo.max_output_tokens = m.max_output_tokens;
  if (m.pricing.cache_read !== undefined) modelInfo.cache_read_input_token_cost = m.pricing.cache_read;
  if (m.pricing.cache_write !== undefined) modelInfo.cache_creation_input_token_cost = m.pricing.cache_write;
  const callKwargs = { ...(m.call_kwargs ?? {}) };
  const headers = { ...((callKwargs.extra_headers as Record<string, string> | undefined) ?? {}) };
  headers['x-litellm-spend-logs-metadata'] = JSON.stringify({ ...(spec.spendMetadata ?? {}), bugfarm_attempt: spec.attemptId });
  callKwargs.extra_headers = headers;
  const agent: Record<string, unknown> = {
    name: 'terminus-2',
    model_name: `openai/${m.model}`,
    kwargs: {
      ...spec.agentKwargs,
      api_base: `${spec.gatewayUrl.replace(/\/+$/, '')}/v1`,
      model_info: modelInfo,
      llm_call_kwargs: callKwargs,
    },
  };
  if (spec.agentTimeoutSec) agent.override_timeout_sec = spec.agentTimeoutSec;
  return {
    job_name: spec.jobName,
    jobs_dir: spec.jobsDir,
    n_attempts: 1,
    n_concurrent_trials: 1,
    quiet: true,
    environment: { type: 'docker', delete: true },
    agents: [agent],
    tasks: [{ path: spec.taskDir }],
  };
}

/** Read one finished trial out of a Harbor job dir. */
export function readTrial(jobDir: string): { trialDir?: string; res?: TrialResultJson } {
  if (!isDir(jobDir)) return {};
  for (const d of readdirSync(jobDir)) {
    const p = join(jobDir, d, 'result.json');
    if (isDir(join(jobDir, d)) && fileExists(p)) return { trialDir: join(jobDir, d), res: readJson<TrialResultJson>(p) };
  }
  const dirs = readdirSync(jobDir).filter((d) => isDir(join(jobDir, d)));
  return { trialDir: dirs[0] ? join(jobDir, dirs[0]) : undefined };
}

/** Pass if the verifier rewarded 1, fail if it rewarded less, error if there is no reward. */
export function judge(res: TrialResultJson | undefined): { result: AttemptResult; reward: number | null; exception?: string } {
  const reward = res?.verifier_result?.rewards?.reward;
  const exc = res?.exception_info ? `${res.exception_info.exception_type ?? 'Exception'}: ${(res.exception_info.exception_message ?? '').slice(0, 300)}` : undefined;
  if (typeof reward !== 'number') return { result: 'error', reward: null, exception: exc ?? 'no verifier reward' };
  return { result: reward >= 1 ? 'pass' : 'fail', reward, exception: exc };
}

/** Copy every ATIF file Harbor wrote for the agent, and write a v1.7 copy of each next to it. */
export function keepTrajectories(trialDir: string | undefined, outDir: string, attemptSlug: string): { raw: string[]; v17: string[] } {
  const raw: string[] = [];
  const v17: string[] = [];
  const agentDir = trialDir ? join(trialDir, 'agent') : '';
  if (!agentDir || !isDir(agentDir)) return { raw, v17 };
  ensureDir(outDir);
  for (const f of readdirSync(agentDir).filter((n) => /^trajectory.*\.json$/.test(n)).sort()) {
    const suffix = f.replace(/^trajectory/, '').replace(/\.json$/, '');
    const dst = join(outDir, `${attemptSlug}${suffix}.atif-v1.8.json`);
    copyFileSync(join(agentDir, f), dst);
    raw.push(dst);
    try {
      const conv = toAtifV17(JSON.parse(readFileSync(dst, 'utf8')));
      const dst17 = join(outDir, `${attemptSlug}${suffix}.atif-v1.7.json`);
      writeFileSync(dst17, JSON.stringify(conv.trajectory, null, 2) + '\n');
      v17.push(dst17);
    } catch (e) {
      log('atif', `could not convert ${dst}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { raw, v17 };
}

export async function runAttempt(spec: AttemptSpec, keep: { trajectoryDir: string; attemptSlug: string }): Promise<AttemptOutcome> {
  ensureDir(spec.jobsDir);
  const cfgPath = join(spec.jobsDir, `${spec.jobName}.config.json`);
  writeText(cfgPath, JSON.stringify(jobConfig(spec), null, 2) + '\n');
  const jobDir = join(spec.jobsDir, spec.jobName);
  const t0 = Date.now();
  let exit: number | null = null;
  try {
    const r = await run(HARBOR_CMD[0], [...HARBOR_CMD.slice(1), 'run', '-c', cfgPath, '-y', '-q'], {
      env: { HARBOR_TELEMETRY: '0', OPENAI_API_KEY: spec.gatewayKey },
      timeoutMs: spec.processTimeoutMs,
      maxBytes: 2 * 1024 * 1024,
    });
    exit = r.code;
    writeText(join(spec.jobsDir, `${spec.jobName}.out`), (r.timedOut ? '[killed: process timeout]\n' : '') + r.stdout + '\n' + r.stderr);
  } finally {
    // Harbor leaks containers and networks when it is killed; clean every project this job started.
    const trialNames = isDir(jobDir) ? readdirSync(jobDir).filter((d) => isDir(join(jobDir, d))) : [];
    await cleanupHarborProjects(trialNames).catch((e: unknown) => log('docker', `cleanup failed for ${spec.jobName}: ${String(e)}`));
  }
  const { trialDir, res } = readTrial(jobDir);
  const verdict = judge(res);
  const traj = keepTrajectories(trialDir, keep.trajectoryDir, keep.attemptSlug);
  const ar = res?.agent_result ?? undefined;
  return {
    ...verdict,
    exception: verdict.exception ?? (exit !== 0 && !res ? `harbor exited ${exit}` : undefined),
    seconds: secs(Date.now() - t0),
    agent_seconds: span(res?.agent_execution),
    verifier_seconds: span(res?.verifier),
    cost_usd_estimate: ar?.cost_usd ?? undefined,
    llm_calls: ar?.metadata?.api_request_times_msec?.length,
    episodes: ar?.metadata?.n_episodes,
    n_input_tokens: ar?.n_input_tokens ?? undefined,
    n_cache_tokens: ar?.n_cache_tokens ?? undefined,
    n_output_tokens: ar?.n_output_tokens ?? undefined,
    job_dir: jobDir,
    trial_dir: trialDir,
    trajectories: traj.raw,
    trajectories_v17: traj.v17,
    harbor_exit: exit,
  };
}
