// Step 5: Harbor controls on packaged tasks, local Docker. oracle must score 1, nop must score 0.
// Nothing that costs money runs until a task passes both.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HARBOR_CMD, HARBOR_CONCURRENCY, JOBS_DIR } from './config.ts';
import { cleanupHarborProjects } from './docker.ts';
import { fileExists, isDir, log, readJson, run, secs, writeText } from './util.ts';

export type ControlAgent = 'oracle' | 'nop';

export interface ControlTrial {
  task: string; // task dir name
  agent: ControlAgent;
  reward: number | null;
  exception?: string;
  seconds: number;
  env_setup_seconds: number;
  verifier_seconds: number;
  trial_dir: string;
}

interface TrialResultJson {
  task_name: string;
  trial_name: string;
  task_id?: { path?: string };
  verifier_result?: { rewards?: Record<string, number> } | null;
  exception_info?: { exception_type?: string; exception_message?: string } | null;
  started_at?: string;
  finished_at?: string;
  environment_setup?: { started_at?: string; finished_at?: string } | null;
  verifier?: { started_at?: string; finished_at?: string } | null;
}

function span(t?: { started_at?: string; finished_at?: string } | null): number {
  if (!t?.started_at || !t.finished_at) return 0;
  return secs(Date.parse(t.finished_at) - Date.parse(t.started_at));
}

/** Run one Harbor job (`harbor run -a <agent>`) over `datasetDir`, optionally limited to some task dir names. */
export async function runHarborAgent(datasetDir: string, agent: ControlAgent, opts: { jobName: string; tasks?: string[]; concurrency?: number; timeoutMs?: number }): Promise<{ trials: ControlTrial[]; jobDir: string; ms: number; exitCode: number | null }> {
  const jobDir = join(JOBS_DIR, opts.jobName);
  const args = [
    ...HARBOR_CMD.slice(1), 'run', '-p', datasetDir, '-a', agent, '-e', 'docker',
    '-n', String(opts.concurrency ?? HARBOR_CONCURRENCY),
    '--jobs-dir', JOBS_DIR, // must be absolute: Harbor resolves relative paths against its own cwd
    '--job-name', opts.jobName, '-q', '-y',
  ];
  for (const t of opts.tasks ?? []) args.push('-i', t);
  log('harbor', `${agent}: ${opts.tasks?.length ?? 'all'} tasks -> ${jobDir}`);
  let r: Awaited<ReturnType<typeof run>> | undefined;
  try {
    r = await run(HARBOR_CMD[0], args, {
      env: { HARBOR_TELEMETRY: '0' },
      timeoutMs: opts.timeoutMs ?? 4 * 3600_000,
      maxBytes: 2 * 1024 * 1024,
    });
    writeText(join(JOBS_DIR, `${opts.jobName}.out`), r.stdout + '\n' + r.stderr);
  } finally {
    // Harbor leaks containers/networks when killed; clean every project this job started.
    const trialNames = isDir(jobDir) ? readdirSync(jobDir).filter((d) => isDir(join(jobDir, d))) : [];
    await cleanupHarborProjects(trialNames);
  }
  const trials: ControlTrial[] = [];
  for (const d of readdirSync(jobDir)) {
    const p = join(jobDir, d, 'result.json');
    if (!fileExists(p)) continue;
    const res = readJson<TrialResultJson>(p);
    const taskPath = res.task_id?.path ?? '';
    const reward = res.verifier_result?.rewards?.reward;
    trials.push({
      task: taskPath ? taskPath.split('/').filter(Boolean).pop() ?? res.task_name : res.task_name,
      agent,
      reward: typeof reward === 'number' ? reward : null,
      exception: res.exception_info ? `${res.exception_info.exception_type}: ${(res.exception_info.exception_message ?? '').slice(0, 300)}` : undefined,
      seconds: span(res),
      env_setup_seconds: span(res.environment_setup),
      verifier_seconds: span(res.verifier),
      trial_dir: join(jobDir, d),
    });
  }
  log('harbor', `${agent}: ${trials.length} trials, rewards ${JSON.stringify(trials.map((t) => t.reward))} in ${secs(r?.ms ?? 0)}s`);
  return { trials, jobDir, ms: r?.ms ?? 0, exitCode: r?.code ?? null };
}

export interface ControlsVerdict {
  task: string;
  oracle: number | null;
  nop: number | null;
  passed: boolean;
  reason?: 'oracle_failed' | 'nop_passed' | 'control_error';
  detail?: string;
}

export function judgeControls(oracle: ControlTrial[], nop: ControlTrial[], tasks: string[]): ControlsVerdict[] {
  return tasks.map((task) => {
    const o = oracle.find((t) => t.task === task);
    const n = nop.find((t) => t.task === task);
    const v: ControlsVerdict = { task, oracle: o?.reward ?? null, nop: n?.reward ?? null, passed: false };
    if (!o || o.reward === null) {
      v.reason = 'control_error';
      v.detail = `oracle: ${o?.exception ?? 'no result'}`;
    } else if (o.reward !== 1) {
      v.reason = 'oracle_failed';
      v.detail = o.exception;
    } else if (!n || n.reward === null) {
      v.reason = 'control_error';
      v.detail = `nop: ${n?.exception ?? 'no result'}`;
    } else if (n.reward !== 0) {
      v.reason = 'nop_passed';
    } else v.passed = true;
    return v;
  });
}
