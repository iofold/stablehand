// One benchmark attempt is one Harbor job with one trial, run as a detached process so that a
// killed runner leaves it running: the next runner adopts it by pid and reads its result, instead
// of losing the attempt or running it twice.
//
// Two kinds of cell:
// - `terminus-2`: Harbor's own agent on the host, driving the task container over tmux. Its model
//   calls go through the gateway on the campaign key, each tagged in the spend log with the
//   attempt id and the campaign tags.
// - `stablehand`: the StablehandAgent (extensions/bugfarm/harbor), which runs a Stablehand harness
//   in a Stablehand sandbox and reaches the task container only through a per-trial relay. Its
//   turn carries the tags {campaign, bench_cell, task, trial}, so the campaign budget covers it.
//
// Every trial's main container carries `bugfarm.run=bench:<id>` and `bugfarm.attempt=<job>`, and
// cleanup only removes the compose projects of this attempt's own trials.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, isDir, log, readJson, secs, writeText } from '../../pipeline/lib/util.ts';
import { cleanupAttempt, judge, keepTrajectories, labelsCompose, labelsComposePath, readTrial } from '../../pipeline/calibrate-harbor.ts';
import type { ResolvedCell } from './config.ts';
import type { BenchAttempt, BenchDefinition, StablehandTurnRef } from './store.ts';

export const STABLEHAND_AGENT_IMPORT = 'stablehand_harbor:StablehandAgent';

export interface LaunchEnv {
  harborBin: string;
  gatewayUrl: string;
  /** Campaign gateway key, for terminus-2 cells. Passed in the process environment only. */
  campaignKey?: string;
  stablehandUrl: string;
  /** Master token, for StablehandAgent cells. Passed in the process environment only. */
  stablehandToken?: string;
}

export function runIdFor(benchId: string): string {
  return `bench:${benchId}`;
}

/** Harbor's JobConfig for one attempt. Contains no secrets. */
export function jobConfig(a: BenchAttempt, cell: ResolvedCell, def: BenchDefinition, taskDir: string, jobsDir: string, gatewayUrl: string): Record<string, unknown> {
  let agent: Record<string, unknown>;
  if (cell.agent === 'terminus-2') {
    const m = cell.model_spec;
    const M = 1e-6;
    const modelInfo: Record<string, number> = {
      max_input_tokens: m.max_input_tokens,
      input_cost_per_token: m.usd_per_mtok.input * M,
      output_cost_per_token: m.usd_per_mtok.output * M,
    };
    if (m.max_output_tokens) modelInfo.max_output_tokens = m.max_output_tokens;
    if (m.usd_per_mtok.cache_read !== undefined) modelInfo.cache_read_input_token_cost = m.usd_per_mtok.cache_read * M;
    if (m.usd_per_mtok.cache_write !== undefined) modelInfo.cache_creation_input_token_cost = m.usd_per_mtok.cache_write * M;
    const callKwargs: Record<string, unknown> = { ...(m.call_kwargs ?? {}) };
    callKwargs.extra_headers = {
      ...((callKwargs.extra_headers as Record<string, string> | undefined) ?? {}),
      'x-litellm-spend-logs-metadata': JSON.stringify({ bugfarm_attempt: a.id, campaign: def.campaign, bench_cell: cell.id, task: a.task, trial: a.id }),
    };
    agent = {
      name: 'terminus-2',
      model_name: `openai/${cell.model}`,
      override_timeout_sec: cell.agent_timeout_sec,
      kwargs: { ...(cell.terminus2_kwargs ?? {}), api_base: `${gatewayUrl.replace(/\/+$/, '')}/v1`, model_info: modelInfo, llm_call_kwargs: callKwargs },
    };
  } else {
    agent = {
      import_path: STABLEHAND_AGENT_IMPORT,
      override_timeout_sec: cell.agent_timeout_sec,
      kwargs: {
        harness: cell.harness,
        model: cell.model,
        campaign: def.campaign,
        bench_cell: cell.id,
        max_cost_usd: cell.max_cost_usd_per_trial,
        turn_timeout_sec: Math.max(60, Math.min(3600, cell.agent_timeout_sec)),
        native_tools: cell.native_tools ?? 'all',
        keep_agent: true,
        ...(cell.agent_kwargs ?? {}),
      },
    };
  }
  return {
    job_name: a.job_name,
    jobs_dir: jobsDir,
    n_attempts: 1,
    n_concurrent_trials: 1,
    quiet: true,
    environment: { type: 'docker', delete: true, extra_docker_compose: [labelsComposePath({ jobsDir, jobName: a.job_name })] },
    agents: [agent],
    tasks: [{ path: taskDir }],
  };
}

export function processDeadlineMs(cell: ResolvedCell): number {
  // Setup (image build, sidecar), the agent, a separate verifier (up to 10 minutes) and slack.
  return (cell.agent_timeout_sec + 600 + 900) * 1000;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is `pid` still the Harbor process of this job (and not a recycled pid)? */
export function isOurHarbor(pid: number | undefined, jobName: string): boolean {
  if (!pid || !pidAlive(pid)) return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`${jobName}.config.json`);
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export interface Launched {
  pid: number;
  exited: Promise<number | null>;
}

/**
 * Start Harbor for one attempt, detached into its own process group with its output in a file,
 * so it survives the runner. Secrets travel in the child's environment only.
 */
export function launch(a: BenchAttempt, cell: ResolvedCell, def: BenchDefinition, taskDir: string, jobsDir: string, env: LaunchEnv): Launched {
  ensureDir(jobsDir);
  const cfgPath = join(jobsDir, `${a.job_name}.config.json`);
  writeText(labelsComposePath({ jobsDir, jobName: a.job_name }), labelsCompose({ runId: runIdFor(def.id), jobName: a.job_name }));
  writeText(cfgPath, JSON.stringify(jobConfig(a, cell, def, taskDir, jobsDir, env.gatewayUrl), null, 2) + '\n');
  const childEnv: Record<string, string | undefined> = { ...process.env, HARBOR_TELEMETRY: '0' };
  // Neither secret should reach the other kind of cell.
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.STABLEHAND_API_TOKEN;
  if (cell.agent === 'terminus-2') {
    if (!env.campaignKey) throw new Error('terminus-2 cells need the campaign key (run `cli.ts setup` first)');
    childEnv.OPENAI_API_KEY = env.campaignKey;
  } else {
    if (!env.stablehandToken) throw new Error('StablehandAgent cells need STABLEHAND_API_TOKEN');
    childEnv.STABLEHAND_API_TOKEN = env.stablehandToken;
    childEnv.STABLEHAND_API_URL = env.stablehandUrl;
  }
  const out = openSync(join(jobsDir, `${a.job_name}.out`), 'a');
  const child = spawn(env.harborBin, ['run', '-c', cfgPath, '-y', '-q'], { detached: true, stdio: ['ignore', out, out], env: childEnv });
  closeSync(out);
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', (e) => {
      log('bench', `${a.job_name}: could not start Harbor: ${e.message}`);
      resolve(null);
    });
  });
  if (!child.pid) throw new Error(`could not start ${env.harborBin}`);
  return { pid: child.pid, exited };
}

/** Wait for a Harbor process this runner did not start (a previous runner's), up to its deadline. */
export async function waitForPid(pid: number, jobName: string, deadlineAt: number, pollMs = 5000): Promise<'exited' | 'killed'> {
  while (isOurHarbor(pid, jobName)) {
    if (Date.now() > deadlineAt) {
      killGroup(pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 30_000));
      if (isOurHarbor(pid, jobName)) killGroup(pid, 'SIGKILL');
      return 'killed';
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return 'exited';
}

/** Kill a launched process when it passes its deadline. */
export function enforceDeadline(l: Launched, jobName: string, deadlineAt: number): () => void {
  const timer = setInterval(() => {
    if (Date.now() <= deadlineAt) return;
    clearInterval(timer);
    log('bench', `${jobName}: past its deadline; stopping Harbor`);
    killGroup(l.pid, 'SIGTERM');
    setTimeout(() => killGroup(l.pid, 'SIGKILL'), 30_000).unref();
  }, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function trialNames(jobDir: string): string[] {
  return isDir(jobDir) ? readdirSync(jobDir).filter((d) => isDir(join(jobDir, d))) : [];
}

interface TurnDetailFile {
  turn?: {
    id?: string;
    agentId?: string;
    conversationId?: string;
    status?: string;
    stopReason?: unknown;
    gatewayCorrelationId?: string;
    usage?: { cost?: { coverage?: string } } | null;
  };
}

function stablehandRef(trialDir: string | undefined): StablehandTurnRef | undefined {
  if (!trialDir) return undefined;
  const p = join(trialDir, 'agent', 'stablehand-turn.json');
  if (!existsSync(p)) {
    // The turn may have started without being collected (a cancelled trial): the agent's metadata
    // in result.json still names it.
    const res = join(trialDir, 'result.json');
    if (!existsSync(res)) return undefined;
    const meta = (readJson<{ agent_result?: { metadata?: { stablehand?: Record<string, unknown> } } }>(res).agent_result?.metadata?.stablehand ?? {}) as Record<string, unknown>;
    if (!meta.turnId) return undefined;
    return { agent_id: meta.agentId as string, turn_id: meta.turnId as string, conversation_id: meta.conversationId as string, gateway_correlation_id: meta.gatewayCorrelationId as string | undefined, status: meta.status as string | undefined };
  }
  const t = readJson<TurnDetailFile>(p).turn ?? {};
  return { agent_id: t.agentId, turn_id: t.id, conversation_id: t.conversationId, gateway_correlation_id: t.gatewayCorrelationId, status: t.status, stop_reason: t.stopReason ?? null, cost_coverage: t.usage?.cost?.coverage };
}

/** Read the finished trial into the attempt, keep its trajectories and remove what it left running. */
export async function finalize(a: BenchAttempt, trajectoryDir: string, exit: number | null): Promise<BenchAttempt> {
  const trials = trialNames(a.job_dir);
  await cleanupAttempt({ jobName: a.job_name }, trials).catch((e: unknown) => log('docker', `cleanup failed for ${a.job_name}: ${String(e)}`));
  const { trialDir, res } = readTrial(a.job_dir);
  const verdict = judge(res);
  const traj = keepTrajectories(trialDir, trajectoryDir, a.job_name);
  const ar = res?.agent_result ?? undefined;
  const span = (t?: { started_at?: string; finished_at?: string } | null) => (t?.started_at && t.finished_at ? secs(Date.parse(t.finished_at) - Date.parse(t.started_at)) : undefined);
  const sh = a.agent === 'stablehand' ? stablehandRef(trialDir) : undefined;
  const estimate = ar?.cost_usd ?? undefined;
  return {
    ...a,
    ...verdict,
    exception: verdict.exception ?? (exit !== 0 && !res ? `harbor exited ${exit}` : undefined),
    status: 'done',
    trial_name: trialDir ? trialDir.split('/').pop() : a.trial_name,
    finished_at: Date.now(),
    seconds: secs(Date.now() - a.started_at),
    agent_seconds: span(res?.agent_execution),
    verifier_seconds: span(res?.verifier),
    cost_usd_estimate: estimate,
    // A StablehandAgent trial reports the turn's own cost once the gateway has priced it.
    cost_usd: a.agent === 'stablehand' && sh?.cost_coverage === 'complete' && typeof estimate === 'number' ? estimate : a.cost_usd,
    cost_state: a.agent === 'stablehand' && sh?.cost_coverage === 'complete' ? 'turn' : typeof estimate === 'number' ? 'estimated' : 'pending',
    n_input_tokens: ar?.n_input_tokens ?? undefined,
    n_output_tokens: ar?.n_output_tokens ?? undefined,
    n_cache_tokens: ar?.n_cache_tokens ?? undefined,
    stablehand: sh,
    trajectories: traj.raw,
    harbor_exit: exit,
    pid: undefined,
  };
}

/** Has this job's trial finished (Harbor wrote its result)? */
export function trialFinished(jobDir: string): boolean {
  return Boolean(readTrial(jobDir).res);
}
