// Step 6: chain scout -> build_env -> check_candidate -> package_task -> controls for one repo
// and write the funnel. Each step is also callable on its own (see cli.ts).
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_CONTAINERS, RESULTS_DIR, TASKS_DIR, WORK_DIR } from './config.ts';
import { buildEnv } from './build-env.ts';
import { checkCandidate } from './check-candidate.ts';
import type { CheckResult } from './check-candidate.ts';
import { judgeControls, runHarborAgent } from './controls.ts';
import type { ControlTrial, ControlsVerdict } from './controls.ts';
import { imageSize, pruneOwnBuildCache, removeLabelledContainers } from './docker.ts';
import { packageTask } from './package-task.ts';
import type { PackagedTask } from './package-task.ts';
import { TASK_BUILD_STEPS, profileFor } from './repos.ts';
import { mineCandidates } from './scout.ts';
import type { Candidate } from './scout.ts';
import { StageTimer, duBytes, ensureDir, fileExists, isDir, log, mapLimit, readJson, run, writeJson } from './util.ts';

const TARGET_TIMEOUT_MS = 5 * 60_000;
const SUBSET_TIMEOUT_MS = 5 * 60_000;

function slugOf(repo: string): string {
  return profileFor(repo).slug;
}

async function loadCandidates(repo: string): Promise<{ candidates: Candidate[]; funnel: Record<string, number> }> {
  const path = join(RESULTS_DIR, slugOf(repo), 'candidates.json');
  const scoutPath = join(RESULTS_DIR, slugOf(repo), 'scout.json');
  if (fileExists(path) && fileExists(scoutPath)) {
    return { candidates: readJson<Candidate[]>(path), funnel: readJson<{ funnel: Record<string, number> }>(scoutPath).funnel };
  }
  const mined = await mineCandidates(repo);
  writeJson(path, mined.candidates);
  writeJson(scoutPath, { repo, head: mined.head, funnel: mined.funnel, candidates: mined.candidates.length, timings: mined.timings });
  return { candidates: mined.candidates, funnel: mined.funnel };
}

export async function checkRepo(repo: string, opts: { limit: number; shas?: string[]; concurrency: number; timer?: StageTimer }): Promise<CheckResult[]> {
  const timer = opts.timer ?? new StageTimer();
  const { candidates } = await timer.time('scout', () => loadCandidates(repo));
  const selected = opts.shas ? candidates.filter((c) => opts.shas?.some((s) => c.sha.startsWith(s))) : candidates.slice(0, opts.limit);
  const env = await timer.time('build_env', () => buildEnv(repo));
  log('check', `${repo}: checking ${selected.length} candidates, concurrency ${opts.concurrency} (max ${MAX_CONTAINERS} containers)`);
  // check_candidate sums per-candidate time; check_wall is the stage's elapsed time under concurrency.
  const results = await timer.time('check_wall', () => mapLimit(selected, opts.concurrency, (c) => {
    const t0 = Date.now();
    return checkCandidate(c, env, { targetTimeoutMs: TARGET_TIMEOUT_MS, subsetTimeoutMs: SUBSET_TIMEOUT_MS }).finally(() => timer.add('check_candidate', Date.now() - t0));
  }));
  writeJson(join(RESULTS_DIR, slugOf(repo), 'checks.json'), results.map((r) => ({ sha: r.sha, subject: r.subject, accepted: r.accepted, reason: r.reason, detail: r.detail?.split('\n')[0], buggy_base: r.buggy_base, f2p: r.fail_to_pass.length, p2p: r.pass_to_pass.length, timings: r.timings })));
  return results;
}

function acceptedChecks(repo: string): CheckResult[] {
  const dir = join(RESULTS_DIR, slugOf(repo), 'checks');
  if (!isDir(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson<CheckResult>(join(dir, f))).filter((c) => c.accepted);
}

export async function packageAccepted(repo: string, onlyShas?: string[]): Promise<PackagedTask[]> {
  const slug = slugOf(repo);
  const { candidates } = await loadCandidates(repo);
  const checks = acceptedChecks(repo).filter((c) => !onlyShas || onlyShas.includes(c.sha));
  const tasks: PackagedTask[] = [];
  for (const check of checks) {
    const cand = candidates.find((c) => c.sha === check.sha);
    if (!cand) continue;
    tasks.push(await packageTask(check, cand));
  }
  ensureDir(join(RESULTS_DIR, slug));
  writeFileSync(join(RESULTS_DIR, slug, 'swebench.jsonl'), tasks.map((t) => JSON.stringify(t.swebench)).join('\n') + (tasks.length ? '\n' : ''));
  log('package', `${repo}: ${tasks.length} tasks in ${join(TASKS_DIR, slug)}`);
  return tasks;
}

export interface ControlsReport {
  oracle: ControlTrial[];
  nop: ControlTrial[];
  verdicts: ControlsVerdict[];
  summary: { tasks: number; passed: number; oracle_failed: number; nop_passed: number; control_error: number; oracle_seconds: number; nop_seconds: number };
}

export async function runControlsForRepo(repo: string, opts: { tasks?: string[]; timer?: StageTimer } = {}): Promise<ControlsReport> {
  const timer = opts.timer ?? new StageTimer();
  const slug = slugOf(repo);
  const datasetDir = join(TASKS_DIR, slug);
  const tasks = opts.tasks ?? (isDir(datasetDir) ? readdirSync(datasetDir).filter((d) => fileExists(join(datasetDir, d, 'task.toml'))) : []);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const filter = opts.tasks ? tasks : undefined;
  const oracle = await timer.time('controls_oracle', () => runHarborAgent(datasetDir, 'oracle', { jobName: `${slug}-oracle-${stamp}`, tasks: filter }));
  const nop = await timer.time('controls_nop', () => runHarborAgent(datasetDir, 'nop', { jobName: `${slug}-nop-${stamp}`, tasks: filter }));
  // Task images are gone (harbor --delete) but their tree-sized COPY layers stay in the build cache.
  await pruneOwnBuildCache(TASK_BUILD_STEPS);
  const verdicts = judgeControls(oracle.trials, nop.trials, tasks);
  const report: ControlsReport = {
    oracle: oracle.trials,
    nop: nop.trials,
    verdicts,
    summary: {
      tasks: tasks.length,
      passed: verdicts.filter((v) => v.passed).length,
      oracle_failed: verdicts.filter((v) => v.reason === 'oracle_failed').length,
      nop_passed: verdicts.filter((v) => v.reason === 'nop_passed').length,
      control_error: verdicts.filter((v) => v.reason === 'control_error').length,
      oracle_seconds: Math.round(oracle.ms / 1000),
      nop_seconds: Math.round(nop.ms / 1000),
    },
  };
  writeJson(join(RESULTS_DIR, slug, 'controls.json'), report);
  return report;
}

async function dockerDf(): Promise<Record<string, string>> {
  const r = await run('docker', ['system', 'df', '--format', '{{.Type}}\t{{.Size}}']);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [k, v] = line.split('\t');
    out[k] = v;
  }
  return out;
}

export interface Funnel {
  repo: string;
  head: string;
  generated_at: string;
  stages: { mined_commits: number; candidates: number; checked: number; fail_to_pass: number; packaged: number; controls_passed: number };
  scout_filters: Record<string, number>;
  rejections: Record<string, number>;
  rejected: Array<{ sha: string; subject: string; reason: string; detail?: string }>;
  accepted_tasks: Array<{ task: string; sha: string; subject: string; f2p: number; p2p: number; oracle: number | null; nop: number | null }>;
  timings: Record<string, { seconds: number; count: number; mean_seconds: number }>;
  /** From the scout pass (clone, log walk, numstat, env build, one HEAD suite run). */
  scout_timings: Record<string, number>;
  wall_seconds: number;
  disk: { work_dir_bytes: number; work_breakdown_bytes: Record<string, number>; env_image_bytes: number; docker_df_before: Record<string, string>; docker_df_after: Record<string, string> };
}

export async function runPipeline(repo: string, opts: { limit: number; concurrency: number }): Promise<Funnel> {
  const t0 = Date.now();
  const timer = new StageTimer();
  const slug = slugOf(repo);
  const dfBefore = await dockerDf();
  const { candidates, funnel: scoutFunnel } = await timer.time('scout', () => loadCandidates(repo));
  const checks = await checkRepo(repo, { limit: opts.limit, concurrency: opts.concurrency, timer });
  const accepted = checks.filter((c) => c.accepted);
  const packaged = await timer.time('package_task', () => packageAccepted(repo, accepted.map((c) => c.sha)));
  const controls = packaged.length
    ? await runControlsForRepo(repo, { tasks: packaged.map((p) => p.dirName), timer })
    : undefined;
  await removeLabelledContainers();

  const rejections: Record<string, number> = {};
  const rejected: Funnel['rejected'] = [];
  for (const c of checks.filter((x) => !x.accepted)) {
    rejections[c.reason ?? 'unknown'] = (rejections[c.reason ?? 'unknown'] ?? 0) + 1;
    rejected.push({ sha: c.sha.slice(0, 12), subject: c.subject, reason: c.reason ?? 'unknown', detail: c.detail?.split('\n')[0].slice(0, 200) });
  }
  for (const v of controls?.verdicts ?? []) {
    if (v.passed) continue;
    const reason = v.reason ?? 'unknown';
    rejections[reason] = (rejections[reason] ?? 0) + 1;
    const p = packaged.find((x) => x.dirName === v.task);
    rejected.push({ sha: p?.sha.slice(0, 12) ?? '', subject: checks.find((c) => c.sha === p?.sha)?.subject ?? '', reason, detail: v.detail });
  }

  const envTag = checks[0]?.env_image ?? '';
  const breakdown: Record<string, number> = {};
  for (const d of ['clones', 'trees', 'tasks', 'jobs', 'results']) breakdown[d] = duBytes(join(WORK_DIR, d));
  const funnel: Funnel = {
    repo,
    head: checks[0]?.head ?? '',
    generated_at: new Date().toISOString(),
    stages: {
      mined_commits: scoutFunnel.commits_since ?? 0,
      candidates: candidates.length,
      checked: checks.length,
      fail_to_pass: accepted.length,
      packaged: packaged.length,
      controls_passed: controls?.summary.passed ?? 0,
    },
    scout_filters: scoutFunnel,
    rejections,
    rejected,
    accepted_tasks: packaged.map((p) => {
      const v = controls?.verdicts.find((x) => x.task === p.dirName);
      return { task: p.dirName, sha: p.sha.slice(0, 12), subject: checks.find((c) => c.sha === p.sha)?.subject ?? '', f2p: p.fail_to_pass, p2p: p.pass_to_pass, oracle: v?.oracle ?? null, nop: v?.nop ?? null };
    }),
    timings: timer.summary(),
    scout_timings: fileExists(join(RESULTS_DIR, slug, 'scout.json')) ? readJson<{ timings?: Record<string, number> }>(join(RESULTS_DIR, slug, 'scout.json')).timings ?? {} : {},
    wall_seconds: Math.round((Date.now() - t0) / 1000),
    disk: {
      work_dir_bytes: Object.values(breakdown).reduce((a, b) => a + b, 0),
      work_breakdown_bytes: breakdown,
      env_image_bytes: envTag ? await imageSize(envTag) : 0,
      docker_df_before: dfBefore,
      docker_df_after: await dockerDf(),
    },
  };
  writeJson(join(RESULTS_DIR, slug, 'funnel.json'), funnel);
  return funnel;
}

export function printFunnel(f: Funnel): void {
  const s = f.stages;
  const pct = (n: number) => (s.checked ? `${Math.round((n / s.checked) * 100)}%` : '-');
  console.log(`\nBugfarm funnel: ${f.repo} @ ${f.head.slice(0, 12)}`);
  console.log(`  mined commits      ${s.mined_commits}`);
  console.log(`  candidates         ${s.candidates}`);
  console.log(`  checked            ${s.checked}`);
  console.log(`  fail-to-pass       ${s.fail_to_pass}  (${pct(s.fail_to_pass)} of checked)`);
  console.log(`  packaged           ${s.packaged}`);
  console.log(`  controls passed    ${s.controls_passed}  (${pct(s.controls_passed)} of checked)`);
  console.log('  rejections:');
  for (const [k, v] of Object.entries(f.rejections).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(24)} ${v}`);
  console.log('  time per stage (s):');
  for (const [k, v] of Object.entries(f.timings)) console.log(`    ${k.padEnd(24)} total ${v.seconds}  n=${v.count}  mean ${v.mean_seconds}`);
  console.log(`  wall: ${f.wall_seconds}s   work dir: ${(f.disk.work_dir_bytes / 1e9).toFixed(2)} GB   env image: ${(f.disk.env_image_bytes / 1e9).toFixed(2)} GB`);
  console.log(`  -> ${join(RESULTS_DIR, profileFor(f.repo).slug, 'funnel.json')}`);
}
