#!/usr/bin/env node
// Difficulty calibration for packaged Bugfarm tasks.
//
//   calibrate(taskDir, panel, budget) -> { perFamily, decision, cost }
//
// Runs Harbor's terminus-2 against a task with each family's ladder model (see calibrate-ladder.ts
// for the method), prices every attempt from the gateway's spend log, writes each attempt and the
// item's per-family difficulty to the board, and keeps every record and ATIF trajectory under
// `.work/calibration/<panel>/`. These are selection attempts: the benchmark measures on attempts
// of its own and never reads these.
//
// CLI: node --experimental-strip-types calibrate.ts <command>   (run without one for help)
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILES } from './lib/repos.ts';
import { Semaphore, ensureDir, fileExists, isDir, log, mapLimit, parseArgs, readJson, secs, writeJson } from './lib/util.ts';
import { BoardClient, NullBoard } from './calibrate-board.ts';
import type { BoardRow, BoardSink } from './calibrate-board.ts';
import { SpendLog, checkRoutes, getCampaignKey, mintCampaignKey, readCampaignKey, readDotenv } from './calibrate-gateway.ts';
import type { CampaignKeyFile, StablehandAdmin } from './calibrate-gateway.ts';
import { RUN_LABEL, judge, readTrial, keepTrajectories, runAttempt } from './calibrate-harbor.ts';
import { toAtifV17 } from './calibrate-atif.ts';
import { cap, decide, familyState, frontierVerdict, plan, stageFits, tally, wilson } from './calibrate-ladder.ts';
import type { AttemptResult, Decision, Family, FamilyView, Tally } from './calibrate-ladder.ts';
import { CALIBRATION_DIR, defaultPanel, freezePanel, loadFrozenPanel, readPanelFile } from './calibrate-panel.ts';
import type { FrozenPanel, PanelModel } from './calibrate-panel.ts';

// ---------------------------------------------------------------------------------------------
// Task identity

export interface TaskInfo {
  dir: string;
  /** Task directory name, e.g. fastapi-0f3e7bd682. */
  name: string;
  /** Board item key, e.g. fastapi@0f3e7bd6. */
  item: string;
  repo: string;
  sha: string;
  title: string;
  /** What the solver is told, and how it is graded: attempts only pool when these match. */
  instruction_sha: string;
  verifier_sha: string;
  environment_sha: string;
}

function sha256(parts: Array<string | Buffer>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

function filesUnder(dir: string): string[] {
  if (!isDir(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function treeSha(root: string, paths: string[]): string {
  const parts: Array<string | Buffer> = [];
  for (const p of paths) {
    parts.push(relative(root, p), '\0', readFileSync(p), '\0');
  }
  return sha256(parts).slice(0, 16);
}

/** `[metadata.bugfarm]` string fields from task.toml (values are JSON-quoted, as package-task writes them). */
export function readBugfarmMetadata(taskToml: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inSection = false;
  for (const line of taskToml.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inSection = t === '[metadata.bugfarm]';
      continue;
    }
    if (!inSection) continue;
    const m = /^([a-z_]+)\s*=\s*(".*")\s*$/.exec(t);
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse(m[2]) as string;
    } catch {
      // Not a plain string value (arrays, numbers); calibration does not need it.
      continue;
    }
  }
  return out;
}

export function itemKeyFor(repo: string, sha: string): string {
  const slug = PROFILES[repo]?.slug ?? repo.split('/').pop()?.toLowerCase() ?? repo;
  return `${slug}@${sha.slice(0, 8)}`;
}

export function readTaskInfo(taskDir: string, itemKey?: string): TaskInfo {
  const dir = resolve(taskDir);
  const tomlPath = join(dir, 'task.toml');
  if (!fileExists(tomlPath)) throw new Error(`${dir} is not a Harbor task (no task.toml)`);
  const meta = readBugfarmMetadata(readFileSync(tomlPath, 'utf8'));
  const repo = meta.repo ?? 'unknown/unknown';
  const sha = meta.fix_sha ?? '';
  const envFiles = ['Dockerfile', 'docker-compose.yaml'].map((f) => join(dir, 'environment', f)).filter(fileExists);
  return {
    dir,
    name: basename(dir),
    item: itemKey ?? (sha ? itemKeyFor(repo, sha) : basename(dir)),
    repo,
    sha,
    title: meta.fix_subject ?? basename(dir),
    instruction_sha: treeSha(dir, [join(dir, 'instruction.md')]),
    verifier_sha: treeSha(dir, filesUnder(join(dir, 'tests'))),
    environment_sha: treeSha(dir, envFiles),
  };
}

// ---------------------------------------------------------------------------------------------
// Attempt records (the selection store; the benchmark keeps its own elsewhere)

export type CostState = 'pending' | 'estimated' | 'gateway' | 'gateway_partial';

export interface AttemptRecord {
  id: string;
  task: string;
  item: string;
  panel_id: string;
  panel_sha: string;
  /** Pooling identity: panel, model, harness, instruction, verifier and environment. */
  cell: string;
  harness: 'terminus-2';
  model: string;
  family: Family;
  try: number;
  phase: 'screen' | 'ladder';
  status: 'running' | 'done';
  result?: AttemptResult;
  reward?: number | null;
  exception?: string;
  started_at: number;
  finished_at?: number;
  seconds?: number;
  agent_seconds?: number;
  verifier_seconds?: number;
  cost_usd?: number;
  cost_usd_estimate?: number;
  cost_state: CostState;
  gateway_calls?: number;
  llm_calls?: number;
  episodes?: number;
  n_input_tokens?: number;
  n_cache_tokens?: number;
  n_output_tokens?: number;
  job_dir: string;
  trial_dir?: string;
  trajectories?: string[];
  trajectories_v17?: string[];
}

export function panelDir(panelId: string): string {
  return join(CALIBRATION_DIR, panelId);
}

function taskStoreDir(panelId: string, taskName: string): string {
  return join(panelDir(panelId), 'tasks', taskName);
}

export function cellFor(panel: FrozenPanel, task: TaskInfo, model: string): string {
  return sha256([[panel.sha, model, panel.harness, panel.harbor_version, task.instruction_sha, task.verifier_sha, task.environment_sha].join('|')]).slice(0, 10);
}

export class AttemptStore {
  readonly dir: string;
  readonly trajectoryDir: string;

  constructor(panelId: string, taskName: string) {
    this.dir = join(taskStoreDir(panelId, taskName), 'attempts');
    this.trajectoryDir = join(taskStoreDir(panelId, taskName), 'trajectories');
    ensureDir(this.dir);
  }

  all(): AttemptRecord[] {
    if (!isDir(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => readJson<AttemptRecord>(join(this.dir, f))).sort((a, b) => a.started_at - b.started_at);
  }

  forCell(model: string, cell: string): AttemptRecord[] {
    return this.all().filter((a) => a.model === model && a.cell === cell);
  }

  private path(rec: AttemptRecord): string {
    return join(this.dir, `${rec.model}-${rec.cell}-t${String(rec.try).padStart(2, '0')}.json`);
  }

  save(rec: AttemptRecord): void {
    writeJson(this.path(rec), rec);
  }

  /** Only for a record whose trial never started (it was still waiting for a slot): not an attempt. */
  dropUnstarted(rec: AttemptRecord): void {
    rmSync(this.path(rec), { force: true });
  }
}

/** Harbor writes the job config right before it starts; no config and no job dir means it never ran. */
function neverStarted(rec: AttemptRecord): boolean {
  return !isDir(rec.job_dir) && !fileExists(`${rec.job_dir}.config.json`);
}

/** A record left `running` by a killed process: read its Harbor result if it finished, else count it as an error. */
export function recoverInterrupted(store: AttemptStore): AttemptRecord[] {
  const fixed: AttemptRecord[] = [];
  for (const rec of store.all().filter((a) => a.status === 'running')) {
    if (neverStarted(rec)) {
      // Queued for a trial slot when the process stopped: no trial ran and no model was called.
      store.dropUnstarted(rec);
      log('cal', `${rec.id}: dropped a queued attempt that never started`);
      continue;
    }
    const { trialDir, res } = readTrial(rec.job_dir);
    const verdict = res ? judge(res) : { result: 'error' as const, reward: null, exception: 'interrupted: the calibration process stopped during this attempt' };
    const slug = `${rec.model}-${rec.cell}-t${String(rec.try).padStart(2, '0')}`;
    const traj = keepTrajectories(trialDir, store.trajectoryDir, slug);
    const done: AttemptRecord = {
      ...rec,
      ...verdict,
      status: 'done',
      finished_at: Date.now(),
      cost_usd_estimate: res?.agent_result?.cost_usd ?? undefined,
      llm_calls: res?.agent_result?.metadata?.api_request_times_msec?.length,
      trial_dir: trialDir,
      trajectories: traj.raw,
      trajectories_v17: traj.v17,
      cost_state: 'estimated',
    };
    store.save(done);
    fixed.push(done);
    log('cal', `${rec.id}: recovered an interrupted attempt as ${done.result}`);
  }
  return fixed;
}

// ---------------------------------------------------------------------------------------------
// Budget

/** Spend accounting for the budget gate: settled spend plus estimates of attempts still running. */
export class BudgetPool {
  readonly limitUsd: number;
  private spent = 0;
  private inflight = 0;

  constructor(limitUsd: number) {
    this.limitUsd = limitUsd;
  }

  remaining(): number {
    return this.limitUsd - this.spent - this.inflight;
  }

  spentUsd(): number {
    return this.spent;
  }

  reserve(usd: number): void {
    this.inflight += usd;
  }

  settle(reservedUsd: number, actualUsd: number): void {
    this.inflight -= reservedUsd;
    this.spent += actualUsd;
  }

  adjust(deltaUsd: number): void {
    this.spent += deltaUsd;
  }
}

/** Per-model attempt cost estimates: the panel's prior until the run has seen real attempts. */
export class CostModel {
  private readonly observed = new Map<string, number[]>();
  private readonly priors: Record<string, PanelModel>;

  constructor(priors: Record<string, PanelModel>) {
    this.priors = priors;
  }

  observe(model: string, usd: number): void {
    const list = this.observed.get(model) ?? [];
    list.push(usd);
    this.observed.set(model, list);
  }

  estimate(model: string): number {
    const prior = this.priors[model]?.est_attempt_usd ?? 0.5;
    const seen = this.observed.get(model) ?? [];
    if (seen.length === 0) return prior;
    const mean = seen.reduce((a, b) => a + b, 0) / seen.length;
    // One observation is noisy; do not let a lucky cheap first attempt lower the gate below the prior.
    return seen.length === 1 ? Math.max(prior, mean) : mean;
  }
}

// ---------------------------------------------------------------------------------------------
// Board rows

export function boardAttemptKey(rec: AttemptRecord): string {
  return `${rec.item}:cal.${rec.panel_id}.${rec.cell}:${rec.harness}:${rec.model}:${rec.try}`;
}

function bestCost(rec: AttemptRecord): number {
  return rec.cost_usd ?? rec.cost_usd_estimate ?? 0;
}

export function attemptRow(rec: AttemptRecord): BoardRow {
  return {
    kind: 'attempt',
    key: boardAttemptKey(rec),
    payload: {
      item: rec.item,
      harness: rec.harness,
      model: rec.model,
      family: rec.family,
      try: rec.try,
      result: rec.result ?? 'error',
      cost_usd: Math.round(bestCost(rec) * 1e6) / 1e6,
      seconds: rec.seconds ?? 0,
      phase: 'calibration',
      at: rec.finished_at ?? rec.started_at,
      screen: rec.phase === 'screen',
      panel: rec.panel_id,
      cell: rec.cell,
      reward: rec.reward ?? null,
      exception: rec.exception ?? null,
      cost_state: rec.cost_state,
      gateway_calls: rec.gateway_calls ?? null,
      trace: rec.trajectories?.[0] ?? null,
      trace_v17: rec.trajectories_v17?.[0] ?? null,
      job_dir: rec.job_dir,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// calibrate()

export interface FamilyResult {
  model: string;
  passes: number;
  attempts: number;
  errors: number;
  rate: number | null;
  ci95: [number, number];
  state: 'too_easy' | 'complete' | 'open' | 'not_measured';
}

export interface CalibrationResult {
  task: string;
  item: string;
  panel: { id: string; sha: string };
  perFamily: Partial<Record<Family, FamilyResult>>;
  decision: Decision | 'screened';
  /** Best-known cost of every attempt on this task under this panel (gateway-priced once settled). */
  cost: number;
  cost_this_call: number;
  cost_settled: boolean;
  screen: { cheap: AttemptResult | null; frontier: AttemptResult | null };
  attempts: number;
}

export interface GatewayContext {
  url: string;
  key: CampaignKeyFile;
  /** Reads the gateway spend log to price attempts exactly; without it costs stay Harbor estimates. */
  spendLog?: SpendLog;
}

export interface CalibrateOptions {
  gateway: GatewayContext;
  board?: BoardSink;
  /** Shared trial slots across concurrent calibrations (default: 6 for this call alone). */
  slots?: Semaphore;
  /** More budget pools to check and charge besides this call's own (e.g. a campaign-wide pool). */
  pools?: BudgetPool[];
  costModel?: CostModel;
  itemKey?: string;
  /** Write the item's stage (calibrating -> accepted/rejected). Off when a foreman owns the item. */
  writeStage?: boolean;
  /** Run only the screen (one cheap and one frontier attempt). */
  screenOnly?: boolean;
  skipScreen?: boolean;
  /** How long to wait at the end for the gateway to price this task's attempts (default 180 s). */
  settleTimeoutMs?: number;
  /** Labels every trial container this call starts (`bugfarm.run`); default: panel id plus a timestamp. */
  runId?: string;
  /** Called after every finished attempt (e.g. to update a campaign's spend on the board). */
  onAttempt?: (rec: AttemptRecord) => void | Promise<void>;
}

/** Gateway-priced costs for done attempts, polled until the spend log has every call. */
export async function settleCosts(store: AttemptStore, recs: AttemptRecord[], spendLog: SpendLog | undefined, opts: { timeoutMs: number; board?: BoardSink; onDelta?: (deltaUsd: number) => void }): Promise<boolean> {
  const open = () => recs.filter((r) => r.status === 'done' && r.cost_state !== 'gateway');
  if (!spendLog || open().length === 0 || opts.timeoutMs <= 0) return open().length === 0;
  const deadline = Date.now() + opts.timeoutMs;
  const lastSeen = new Map<string, string>();
  while (open().length > 0) {
    const snap = await spendLog.snapshot(10_000);
    const rows: BoardRow[] = [];
    for (const rec of open()) {
      const s = snap.by_attempt.get(rec.id);
      const expected = rec.llm_calls;
      const sig = s ? `${s.calls}:${s.cost_usd.toFixed(8)}` : 'none';
      const prev = lastSeen.get(rec.id);
      lastSeen.set(rec.id, sig);
      const oldEnough = Date.now() - (rec.finished_at ?? 0) > 20_000;
      const complete = expected === 0 ? true : s !== undefined && s.calls >= Math.max(1, expected ?? 1);
      const stable = prev === sig;
      const timedOut = Date.now() > deadline;
      if (!(oldEnough && complete && stable) && !timedOut) continue;
      const before = bestCost(rec);
      rec.cost_usd = s ? s.cost_usd : expected === 0 ? 0 : undefined;
      rec.gateway_calls = s?.calls ?? 0;
      rec.cost_state = complete && stable ? 'gateway' : s ? 'gateway_partial' : 'estimated';
      store.save(rec);
      opts.onDelta?.(bestCost(rec) - before);
      rows.push(attemptRow(rec));
    }
    if (rows.length && opts.board) await opts.board.write(rows);
    if (Date.now() > deadline) break;
    if (open().length > 0) await new Promise((r) => setTimeout(r, 15_000));
  }
  return open().length === 0;
}

function familyResult(model: string, t: Tally, cfgLadder: FrozenPanel['ladder']): FamilyResult {
  const st = familyState(t, cfgLadder);
  return {
    model,
    passes: t.passes,
    attempts: t.attempts,
    errors: t.errors,
    rate: t.attempts ? Math.round((t.passes / t.attempts) * 1000) / 1000 : null,
    ci95: wilson(t.passes, t.attempts).map((x) => Math.round(x * 1000) / 1000) as [number, number],
    state: t.attempts === 0 ? 'not_measured' : st.kind === 'too_easy' ? 'too_easy' : st.kind === 'complete' ? 'complete' : 'open',
  };
}

const REJECT_REASON: Partial<Record<Decision, string>> = {
  too_easy: 'too_easy',
  out_of_band: 'out_of_band',
  unsolved_review: 'unsolved_review',
  over_budget: 'over_budget',
  held: 'held_errors',
};

/** Per-family pass counts of a task's ladder models, from its stored attempts. */
export function ladderViews(panel: FrozenPanel, task: TaskInfo, store: AttemptStore, blocked: Set<Family> = new Set()): FamilyView[] {
  return panel.families
    .filter((f): f is typeof f & { ladder: string } => Boolean(f.ladder))
    .map((f) => {
      const recs = store.forCell(f.ladder, cellFor(panel, task, f.ladder));
      return {
        family: f.family,
        model: f.ladder,
        tally: tally(recs.map((r) => (r.status === 'running' ? 'pending' : r.result ?? 'error'))),
        budget_blocked: blocked.has(f.family),
      };
    });
}

function diffStats(patch: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { files, additions, deletions };
}

/**
 * The item's board row: per-family difficulty and the calibration record. With `writeStage` (no
 * foreman owns the item), also its stage, receipt fields and, once decided, accepted or rejected.
 */
export function itemRowFor(panel: FrozenPanel, task: TaskInfo, store: AttemptStore, writeStage: boolean, final?: { decision: Decision }): BoardRow {
  const difficulty: Record<string, { passes: number; attempts: number }> = {};
  const models: Record<string, string> = {};
  for (const v of ladderViews(panel, task, store)) {
    difficulty[v.family] = { passes: v.tally.passes, attempts: v.tally.attempts };
    models[v.family] = v.model;
  }
  const cost = store.all().filter((a) => a.panel_id === panel.id).reduce((s, a) => s + bestCost(a), 0);
  const payload: Record<string, unknown> = {
    difficulty,
    calibration: {
      panel: panel.id,
      panel_sha: panel.sha,
      harness: panel.harness,
      models,
      frontier: panel.frontier,
      decision: final?.decision ?? null,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      updated_at: Date.now(),
    },
  };
  if (writeStage) {
    payload.repo = task.repo;
    payload.sha = task.sha;
    payload.title = task.title;
    payload.url = `https://github.com/${task.repo}/commit/${task.sha}`;
    payload.cost_usd = Math.round(cost * 1e6) / 1e6;
    const patchPath = join(task.dir, 'solution', 'fix.patch');
    if (fileExists(patchPath)) {
      const patch = readFileSync(patchPath, 'utf8');
      payload.diff = patch.slice(0, 400_000);
      payload.diff_stats = diffStats(patch);
    }
    const expectedPath = join(task.dir, 'tests', 'expected.json');
    if (fileExists(expectedPath)) payload.failing_tests = (readJson<{ fail_to_pass?: string[] }>(expectedPath).fail_to_pass ?? []).slice(0, 500);
    if (!final) payload.stage = 'calibrating';
    else if (final.decision === 'accept') {
      payload.stage = 'accepted';
      payload.reject_reason = null;
      payload.reject_detail = null;
    } else {
      payload.stage = 'rejected';
      payload.reject_reason = REJECT_REASON[final.decision] ?? final.decision;
      payload.reject_detail = rejectDetail(final.decision, difficulty, panel);
    }
  } else if (!final) {
    payload.stage = 'calibrating';
  }
  return { kind: 'item', key: task.item, payload };
}

export async function calibrate(taskDir: string, panel: FrozenPanel, budget: number, opts: CalibrateOptions): Promise<CalibrationResult> {
  const task = readTaskInfo(taskDir, opts.itemKey);
  const store = new AttemptStore(panel.id, task.name);
  const board = opts.board ?? new NullBoard();
  const slots = opts.slots ?? new Semaphore(6);
  const costModel = opts.costModel ?? new CostModel(panel.models);
  const own = new BudgetPool(budget);
  const pools = [own, ...(opts.pools ?? [])];
  const jobsDir = join(panelDir(panel.id), 'jobs');
  const runId = opts.runId ?? `${panel.id}-${Date.now().toString(36)}`;
  const cells = new Map<string, string>();
  const cellOf = (model: string) => {
    let c = cells.get(model);
    if (!c) {
      c = cellFor(panel, task, model);
      cells.set(model, c);
    }
    return c;
  };
  const familyOf = (model: string): Family => panel.models[model]?.family ?? 'open';

  const recovered = recoverInterrupted(store);
  if (recovered.length) await board.write(recovered.map(attemptRow));

  const inflight = new Map<string, Promise<void>>();
  let costThisCall = 0;

  const remaining = () => Math.min(...pools.map((p) => p.remaining()));
  const fits = (k: number, model: string, held = 0) => {
    const est = costModel.estimate(model);
    return stageFits(remaining() - held, k, est, est * panel.reserve_factor);
  };
  // The frontier decides the band, so its next stage is protected: another family's stage only
  // launches if the budget also covers the frontier's next stage.
  const frontierHold = (): number => {
    const f = views().find((v) => v.family === panel.frontier);
    if (!f || frontierVerdict(f.tally, panel.ladder, panel.band)) return 0;
    const launched = f.tally.attempts + f.tally.pending;
    if (launched >= cap(panel.ladder)) return 0;
    const target = panel.ladder.stages.find((s) => s > launched) ?? cap(panel.ladder);
    const est = costModel.estimate(f.model);
    return (target - launched) * (est + est * panel.reserve_factor);
  };

  const views = (blocked: Set<Family> = new Set()): FamilyView[] => ladderViews(panel, task, store, blocked);

  const itemRow = (final?: { decision: Decision }): BoardRow => itemRowFor(panel, task, store, Boolean(opts.writeStage), final);

  const launch = (model: string, phase: 'screen' | 'ladder') => {
    const cell = cellOf(model);
    const tries = store.forCell(model, cell).map((r) => r.try);
    const tryNo = (tries.length ? Math.max(...tries) : 0) + 1;
    const id = `${task.name}:${panel.id}:${cell}:${model}:${tryNo}`;
    const slug = `${model}-${cell}-t${String(tryNo).padStart(2, '0')}`;
    const jobName = `${task.name}__${slug}__${randomBytes(3).toString('hex')}`;
    const rec: AttemptRecord = {
      id,
      task: task.name,
      item: task.item,
      panel_id: panel.id,
      panel_sha: panel.sha,
      cell,
      harness: 'terminus-2',
      model,
      family: familyOf(model),
      try: tryNo,
      phase,
      status: 'running',
      started_at: Date.now(),
      cost_state: 'pending',
      job_dir: join(jobsDir, jobName),
    };
    store.save(rec);
    const est = costModel.estimate(model);
    for (const p of pools) p.reserve(est);
    log('cal', `${task.item} ${model} try ${tryNo} (${phase}) launched; est $${est.toFixed(3)}, budget left $${remaining().toFixed(2)}`);
    const job = (async () => {
      let done: AttemptRecord;
      try {
        const out = await slots.use(() =>
          runAttempt(
            {
              attemptId: id,
              taskDir: task.dir,
              jobsDir,
              jobName,
              model: panel.models[model],
              agentKwargs: panel.agent_kwargs,
              agentTimeoutSec: panel.agent_timeout_sec,
              gatewayUrl: opts.gateway.url,
              gatewayKey: opts.gateway.key.key,
              spendMetadata: { bugfarm_panel: panel.id, bugfarm_item: task.item },
              processTimeoutMs: (panel.agent_timeout_sec + 3600) * 1000,
              runId,
            },
            { trajectoryDir: store.trajectoryDir, attemptSlug: slug },
          ),
        );
        done = {
          ...rec,
          status: 'done',
          result: out.result,
          reward: out.reward,
          exception: out.exception,
          finished_at: Date.now(),
          seconds: out.seconds,
          agent_seconds: out.agent_seconds,
          verifier_seconds: out.verifier_seconds,
          cost_usd_estimate: out.cost_usd_estimate,
          cost_state: 'estimated',
          llm_calls: out.llm_calls,
          episodes: out.episodes,
          n_input_tokens: out.n_input_tokens,
          n_cache_tokens: out.n_cache_tokens,
          n_output_tokens: out.n_output_tokens,
          trial_dir: out.trial_dir,
          trajectories: out.trajectories,
          trajectories_v17: out.trajectories_v17,
        };
      } catch (e) {
        done = { ...rec, status: 'done', result: 'error', reward: null, exception: `runner: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400), finished_at: Date.now(), seconds: secs(Date.now() - rec.started_at), cost_state: 'estimated' };
      }
      store.save(done);
      const actual = bestCost(done);
      for (const p of pools) p.settle(est, actual);
      costThisCall += actual;
      if (done.cost_usd_estimate !== undefined) costModel.observe(model, done.cost_usd_estimate);
      log('cal', `${task.item} ${model} try ${tryNo}: ${done.result}${done.exception ? ` (${done.exception.slice(0, 120)})` : ''} $${actual.toFixed(4)} ${done.seconds ?? 0}s`);
      await board.write([attemptRow(done), itemRow()]);
      await opts.onAttempt?.(done);
    })();
    const tracked = job.finally(() => inflight.delete(id));
    inflight.set(id, tracked);
  };

  await board.write([itemRow()]);

  // Screen: one cheap and one frontier attempt, unless this cell already has attempts.
  const screenModels = [...new Set([panel.screen.cheap, panel.screen.frontier])];
  if (!opts.skipScreen) {
    for (const m of screenModels) {
      if (store.forCell(m, cellOf(m)).length > 0) continue;
      if (fits(1, m)) launch(m, 'screen');
      else log('cal', `${task.item}: budget gate refused the ${m} screen attempt`);
    }
    await Promise.all(inflight.values());
  }
  const screenResult = (m: string): AttemptResult | null => {
    const first = store.forCell(m, cellOf(m))[0];
    return first?.status === 'done' ? first.result ?? 'error' : null;
  };

  let decision: Decision | 'screened' = 'screened';
  if (!opts.screenOnly) {
    for (;;) {
      const blocked = new Set<Family>();
      let launched = 0;
      for (const step of plan(views(), panel.frontier, panel.ladder, panel.band)) {
        if (fits(step.launch, step.model, step.family === panel.frontier ? 0 : frontierHold())) {
          for (let i = 0; i < step.launch; i++) launch(step.model, 'ladder');
          launched += step.launch;
        } else {
          blocked.add(step.family);
          log('cal', `${task.item}: budget gate refused ${step.launch} × ${step.model} (est $${costModel.estimate(step.model).toFixed(3)} + reserve, left $${remaining().toFixed(2)})`);
        }
      }
      const d = decide(views(blocked), panel.frontier, panel.ladder, panel.band);
      if (inflight.size === 0) {
        decision = d ?? 'over_budget';
        break;
      }
      await Promise.race(inflight.values());
    }
    await Promise.all(inflight.values());
  }

  const all = store.all().filter((a) => a.panel_id === panel.id && a.cell === cellOf(a.model));
  const settled = await settleCosts(store, all, opts.gateway.spendLog, {
    timeoutMs: opts.settleTimeoutMs ?? 180_000,
    board,
    onDelta: (d) => {
      costThisCall += d;
      for (const p of pools) p.adjust(d);
    },
  });

  const perFamily: Partial<Record<Family, FamilyResult>> = {};
  for (const v of views()) perFamily[v.family] = familyResult(v.model, v.tally, panel.ladder);
  const result: CalibrationResult = {
    task: task.name,
    item: task.item,
    panel: { id: panel.id, sha: panel.sha },
    perFamily,
    decision,
    cost: Math.round(all.reduce((s, a) => s + bestCost(a), 0) * 1e6) / 1e6,
    cost_this_call: Math.round(costThisCall * 1e6) / 1e6,
    cost_settled: settled,
    screen: { cheap: screenResult(panel.screen.cheap), frontier: screenResult(panel.screen.frontier) },
    attempts: all.length,
  };
  writeJson(join(taskStoreDir(panel.id, task.name), 'summary.json'), { ...result, task_info: task, updated_at: new Date().toISOString() });
  if (decision !== 'screened') writeTaskCalibration(task.dir, panel, result);
  await board.write([itemRow(decision === 'screened' ? undefined : { decision })]);
  log('cal', `${task.item}: ${decision} — ${Object.entries(perFamily).map(([f, r]) => `${f} ${r?.passes}/${r?.attempts}`).join(', ')} — $${result.cost.toFixed(3)}`);
  return result;
}

const TOML_BEGIN = '# --- bugfarm calibration (written by calibrate.ts; replaced on every calibration) ---';
const TOML_END = '# --- end bugfarm calibration ---';

/**
 * Record the per-family difficulty in the task's own task.toml, under
 * `[metadata.bugfarm.calibration]` and `[metadata.bugfarm.difficulty.<family>]`. The block sits
 * between marker comments at the end of the file and is replaced on every calibration, so the
 * task always carries the latest receipt. task.toml is not part of a cell's identity (instruction,
 * tests and environment are), so writing it never splits a cell.
 */
export function calibrationToml(panel: FrozenPanel, result: CalibrationResult): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = [
    TOML_BEGIN,
    '[metadata.bugfarm.calibration]',
    `panel = ${q(panel.id)}`,
    `panel_sha = ${q(panel.sha)}`,
    `harness = ${q(panel.harness)}`,
    `harbor_version = ${q(panel.harbor_version)}`,
    `frontier_family = ${q(panel.frontier)}`,
    `decision = ${q(result.decision)}`,
    `attempts = ${result.attempts}`,
    `cost_usd = ${result.cost}`,
    `calibrated_at = ${q(new Date().toISOString())}`,
    'phase = "selection"',
  ];
  for (const [family, r] of Object.entries(result.perFamily)) {
    if (!r) continue;
    lines.push(
      '',
      `[metadata.bugfarm.difficulty.${family}]`,
      `model = ${q(r.model)}`,
      `passes = ${r.passes}`,
      `attempts = ${r.attempts}`,
      `errors = ${r.errors}`,
      `state = ${q(r.state)}`,
    );
  }
  lines.push(TOML_END, '');
  return lines.join('\n');
}

export function writeTaskCalibration(taskDir: string, panel: FrozenPanel, result: CalibrationResult): void {
  const path = join(taskDir, 'task.toml');
  let text = readFileSync(path, 'utf8');
  const begin = text.indexOf(TOML_BEGIN);
  if (begin >= 0) {
    const end = text.indexOf(TOML_END, begin);
    text = text.slice(0, begin) + (end >= 0 ? text.slice(end + TOML_END.length).replace(/^\n/, '') : '');
  }
  writeFileSync(path, `${text.replace(/\n*$/, '\n')}\n${calibrationToml(panel, result)}`);
}

function rejectDetail(decision: Decision, difficulty: Record<string, { passes: number; attempts: number }>, panel: FrozenPanel): string {
  const counts = Object.entries(difficulty).map(([f, d]) => `${f} ${d.passes}/${d.attempts}`).join(', ');
  const why: Record<string, string> = {
    too_easy: `the frontier family (${panel.frontier}) stopped early as too easy`,
    out_of_band: `the frontier family (${panel.frontier}) passes more than ${Math.round(panel.band.max_frontier_rate * 100)}%`,
    unsolved_review: 'no family solved it; check whether the task is broken or just hard',
    over_budget: 'the budget ran out before the ladder could decide; calibrating again with more budget resumes it',
    held: 'errored attempts could change the decision; look at them before moving on',
  };
  return `${why[decision] ?? decision} (${counts}; panel ${panel.id})`;
}

// ---------------------------------------------------------------------------------------------
// Many tasks: screen everything, then ladder with a fair share of the budget, then hand the
// leftover to the tasks the budget stopped.

export interface ManyOptions extends Omit<CalibrateOptions, 'slots' | 'pools' | 'costModel' | 'itemKey' | 'screenOnly' | 'skipScreen' | 'onAttempt'> {
  totalBudget: number;
  /** Trials at a time, across all tasks. */
  concurrency: number;
  /** Tasks laddering at a time (default: half the trial slots). */
  taskConcurrency?: number;
  /** Extra spend already charged to the same campaign key, outside these tasks. */
  alreadySpent?: number;
  /** Keep a campaign row on the board (spend against the cap) under this key. */
  campaign?: { key: string; name: string; repo: string; cap_usd: number };
}

export function campaignRow(c: NonNullable<ManyOptions['campaign']>, spendUsd: number, extra: Record<string, unknown> = {}): BoardRow {
  return { kind: 'campaign', key: c.key, payload: { name: c.name, repo: c.repo, cap_usd: c.cap_usd, spend_usd: Math.round(spendUsd * 1e6) / 1e6, ...extra } };
}

/**
 * Ladder priority (lower goes first), from the attempts so far, screen included:
 * 0. the frontier has passed every attempt: one more pass may settle `too_easy` cheaply;
 * 1. someone passed and the frontier has only missed: likely `accept` once the frontier's misses
 *    make the ceiling certain (in the prior factory 81% of first misses repeated); more misses first;
 * 2. someone passed and the frontier is mixed: likely in band, but it needs the full ladder;
 * 3. nobody has passed yet: the most expensive to decide, and possibly broken.
 * Errors read as misses here.
 */
export function ladderPriority(views: FamilyView[], frontier: Family): number {
  const f = views.find((v) => v.family === frontier);
  if (!f) return 9;
  const floor = views.some((v) => v.tally.passes > 0);
  const { passes, attempts } = f.tally;
  if (attempts > 0 && passes === attempts) return 0;
  if (floor && passes === 0) return 1 - Math.min(attempts, 16) / 100;
  if (floor) return 2;
  return 3;
}

export async function calibrateMany(taskDirs: string[], panel: FrozenPanel, opts: ManyOptions): Promise<CalibrationResult[]> {
  const slots = new Semaphore(opts.concurrency);
  const campaign = new BudgetPool(opts.totalBudget);
  if (opts.alreadySpent) campaign.adjust(opts.alreadySpent);
  const costModel = new CostModel(panel.models);
  const board = opts.board ?? new NullBoard();
  let lastCampaignWrite = 0;
  const onAttempt = async () => {
    if (!opts.campaign || Date.now() - lastCampaignWrite < 10_000) return;
    lastCampaignWrite = Date.now();
    await board.write([campaignRow(opts.campaign, campaign.spentUsd())]);
  };
  const runId = opts.runId ?? `${panel.id}-${Date.now().toString(36)}`;
  const base = { ...opts, slots, costModel, pools: [campaign], onAttempt, runId };
  log('cal', `run ${runId}: trial containers carry ${RUN_LABEL}=${runId}`);

  // Prior spend on these tasks under this panel counts against the campaign budget.
  let recoveredCount = 0;
  let priorCount = 0;
  for (const d of taskDirs) {
    const t = readTaskInfo(d);
    const store = new AttemptStore(panel.id, t.name);
    // A killed run leaves records `running`: take Harbor's result if the trial finished, else an error.
    const recovered = recoverInterrupted(store);
    if (recovered.length) await board.write(recovered.map(attemptRow));
    recoveredCount += recovered.length;
    const prior = store.all().filter((a) => a.status === 'done');
    priorCount += prior.length;
    for (const a of prior) {
      campaign.adjust(bestCost(a));
      if (a.cost_usd_estimate !== undefined) costModel.observe(a.model, a.cost_usd_estimate);
    }
  }
  log('cal', `campaign budget $${opts.totalBudget.toFixed(2)}, $${campaign.remaining().toFixed(2)} left after prior attempts; ${taskDirs.length} tasks, ${opts.concurrency} trials at a time`);

  const startedAt = Date.now();
  const resumed = priorCount > 0;
  if (opts.campaign) await board.write([campaignRow(opts.campaign, campaign.spentUsd(), { status: 'running', unattended_since: startedAt, finished_at: null, ...(recoveredCount > 0 ? { recovered_from_crash: 1 } : {}), ...(resumed ? {} : { started_at: startedAt }) })]);
  log('cal', '--- screen ---');
  const screened = await Promise.all(taskDirs.map((d) => calibrate(d, panel, campaign.remaining(), { ...base, screenOnly: true, settleTimeoutMs: 0 })));

  // Ladder: greedy, in priority order. A few tasks at a time each draw on the whole remaining
  // budget, so the tasks closest to a decision are funded to the end instead of every task getting
  // a share too small for its next stage. Repeat while a pass still spends.
  const taskConcurrency = opts.taskConcurrency ?? Math.max(1, Math.ceil(opts.concurrency / 2));
  const results = new Map<string, CalibrationResult>();
  let open = [...taskDirs];
  for (let pass = 1; open.length > 0; pass++) {
    if (campaign.remaining() <= 0) break;
    const ordered = open
      .map((d) => {
        const t = readTaskInfo(d);
        return { d, p: ladderPriority(ladderViews(panel, t, new AttemptStore(panel.id, t.name)), panel.frontier) };
      })
      .sort((a, b) => a.p - b.p)
      .map((x) => x.d);
    log('cal', `--- ladder pass ${pass}: ${ordered.length} tasks, ${taskConcurrency} at a time, $${campaign.remaining().toFixed(2)} left ---`);
    const before = campaign.spentUsd();
    const rs = await mapLimit(ordered, taskConcurrency, (d) => calibrate(d, panel, Math.max(0, campaign.remaining()), { ...base, skipScreen: true, settleTimeoutMs: 0 }));
    rs.forEach((r, i) => results.set(ordered[i], r));
    const spent = campaign.spentUsd() - before;
    open = ordered.filter((d) => results.get(d)?.decision === 'over_budget');
    if (spent <= 1e-6) break; // nothing could launch: the budget is spent
  }
  if (opts.campaign) await board.write([campaignRow(opts.campaign, campaign.spentUsd(), { status: 'done', finished_at: Date.now() })]);
  return taskDirs.map((d) => results.get(d) ?? screened[taskDirs.indexOf(d)]);
}

// ---------------------------------------------------------------------------------------------
// Reconciliation: attempt costs against the gateway's spend log and Stablehand's campaign spend.

export interface Reconciliation {
  campaign_key_id: string;
  attempts: number;
  attempts_cost_usd: number;
  /** Finished attempts the spend log has no rows for yet (their cost is Harbor's estimate). */
  attempts_unsettled: number;
  attempts_running: number;
  gateway_rows: number;
  gateway_total_usd: number;
  /** Rows of the key without an attempt id (route checks, strays). */
  gateway_unattributed: { calls: number; cost_usd: number };
  /** Rows tagged with an attempt id that has no finished record under this panel. */
  gateway_other_attempts: { calls: number; cost_usd: number };
  stablehand_spend_usd: number | null;
  stablehand_calls: number | null;
  difference_usd: number | null;
}

export async function reconcile(panelId: string, ctx: { gateway: GatewayContext; admin?: StablehandAdmin; board?: BoardSink }): Promise<Reconciliation> {
  const dir = join(panelDir(panelId), 'tasks');
  const stores = isDir(dir) ? readdirSync(dir).map((t) => new AttemptStore(panelId, t)) : [];
  const snap = ctx.gateway.spendLog ? await ctx.gateway.spendLog.snapshot(0) : undefined;
  let cost = 0;
  let count = 0;
  let unsettled = 0;
  let running = 0;
  const known = new Set<string>();
  const rows: BoardRow[] = [];
  for (const store of stores) {
    for (const rec of store.all()) {
      if (rec.status !== 'done') {
        running++;
        continue;
      }
      count++;
      known.add(rec.id);
      const s = snap?.by_attempt.get(rec.id);
      if (s && (rec.cost_usd !== s.cost_usd || rec.gateway_calls !== s.calls || rec.cost_state !== 'gateway')) {
        rec.cost_usd = s.cost_usd;
        rec.gateway_calls = s.calls;
        rec.cost_state = 'gateway';
        store.save(rec);
        rows.push(attemptRow(rec));
      } else if (!s && rec.cost_state !== 'gateway') {
        unsettled++;
      }
      cost += bestCost(rec);
    }
  }
  if (rows.length && ctx.board) await ctx.board.write(rows);
  let sh: { costUsd: number; calls: number } | null = null;
  if (ctx.admin) {
    const k = await getCampaignKey(ctx.admin, ctx.gateway.key.id);
    sh = { costUsd: k.spend.costUsd, calls: k.spend.calls };
  }
  const other = { calls: 0, cost_usd: 0 };
  for (const [id, s] of snap?.by_attempt ?? []) {
    if (known.has(id)) continue;
    other.calls += s.calls;
    other.cost_usd += s.cost_usd;
  }
  return {
    campaign_key_id: ctx.gateway.key.id,
    attempts: count,
    attempts_cost_usd: Math.round(cost * 1e6) / 1e6,
    attempts_unsettled: unsettled,
    attempts_running: running,
    gateway_rows: snap?.rows ?? 0,
    gateway_total_usd: Math.round((snap?.total_usd ?? 0) * 1e6) / 1e6,
    gateway_unattributed: snap ? { calls: snap.unattributed.calls, cost_usd: Math.round(snap.unattributed.cost_usd * 1e6) / 1e6 } : { calls: 0, cost_usd: 0 },
    gateway_other_attempts: { calls: other.calls, cost_usd: Math.round(other.cost_usd * 1e6) / 1e6 },
    stablehand_spend_usd: sh ? Math.round(sh.costUsd * 1e6) / 1e6 : null,
    stablehand_calls: sh?.calls ?? null,
    difference_usd: sh ? Math.round((sh.costUsd - cost) * 1e6) / 1e6 : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Report

export function summaries(panelId: string): CalibrationResult[] {
  const dir = join(panelDir(panelId), 'tasks');
  if (!isDir(dir)) return [];
  return readdirSync(dir).map((t) => join(dir, t, 'summary.json')).filter(fileExists).map((p) => readJson<CalibrationResult>(p));
}

/** Every finished attempt under a panel, by model: passes, errors, cost and time. */
export function modelTable(panelId: string): string {
  const dir = join(panelDir(panelId), 'tasks');
  const byModel = new Map<string, { n: number; pass: number; err: number; cost: number; secs: number; screen: number }>();
  for (const t of isDir(dir) ? readdirSync(dir) : []) {
    for (const a of new AttemptStore(panelId, t).all().filter((x) => x.status === 'done')) {
      const m = byModel.get(a.model) ?? { n: 0, pass: 0, err: 0, cost: 0, secs: 0, screen: 0 };
      m.n++;
      if (a.result === 'pass') m.pass++;
      if (a.result === 'error') m.err++;
      if (a.phase === 'screen') m.screen++;
      m.cost += bestCost(a);
      m.secs += a.seconds ?? 0;
      byModel.set(a.model, m);
    }
  }
  const lines = ['| model | attempts (screen) | passes | errors | cost | $/attempt | min/attempt |', '|---|---|---|---|---|---|---|'];
  for (const [model, m] of [...byModel].sort((a, b) => b[1].cost - a[1].cost)) {
    lines.push(`| ${model} | ${m.n} (${m.screen}) | ${m.pass} | ${m.err} | $${m.cost.toFixed(2)} | $${(m.cost / m.n).toFixed(3)} | ${(m.secs / m.n / 60).toFixed(1)} |`);
  }
  return lines.join('\n');
}

export function reportTable(panel: FrozenPanel, results: CalibrationResult[]): string {
  const fams = panel.families.filter((f) => f.ladder).map((f) => f.family);
  const head = ['item', 'decision', ...fams.map((f) => `${f} (${panel.families.find((x) => x.family === f)?.ladder})`), 'attempts', 'cost'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  const totals = new Map<Family, { p: number; n: number }>();
  for (const r of [...results].sort((a, b) => a.item.localeCompare(b.item))) {
    const cells = fams.map((f) => {
      const x = r.perFamily[f];
      const t = totals.get(f) ?? { p: 0, n: 0 };
      t.p += x?.passes ?? 0;
      t.n += x?.attempts ?? 0;
      totals.set(f, t);
      return x ? `${x.passes}/${x.attempts}${x.state === 'too_easy' ? ' (too easy)' : ''}` : '–';
    });
    lines.push(`| ${r.item} | ${r.decision} | ${cells.join(' | ')} | ${r.attempts} | $${r.cost.toFixed(2)} |`);
  }
  const cost = results.reduce((s, r) => s + r.cost, 0);
  lines.push(`| **all ${results.length}** | ${results.filter((r) => r.decision === 'accept').length} in band | ${fams.map((f) => `${totals.get(f)?.p ?? 0}/${totals.get(f)?.n ?? 0}`).join(' | ')} | ${results.reduce((s, r) => s + r.attempts, 0)} | $${cost.toFixed(2)} |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = `usage: calibrate.ts <command> [options]

  routes      [--key-file f] [--models a,b]     Ask each panel model for one word through the gateway
  freeze      [--panel-id cal-v1] [--panel panel.json] [--key-file f]
              Check every panel route, then freeze the panel (refuses to change a frozen id)
  mint-key    --campaign <tag> --max-budget <usd> [--key-file f] [--name n]
              Mint a Stablehand campaign gateway key for the panel's models (master token)
  one         <taskDir> --budget <usd> [--panel cal-v1] [--stage] [--item key]
              calibrate() one task and print its result as JSON
  run         <taskDir...> | --tasks-dir <dir>  --budget <usd> [--concurrency 6] [--task-concurrency 3] [--panel cal-v1] [--stage]
              Screen every task, then ladder them within one budget; prints the report
  reconcile   [--panel cal-v1]   Re-price attempts from the spend log; compare with Stablehand's campaign spend
  board-sync  [--panel cal-v1] [--stage]   Re-send every stored attempt and item row to the board
  report      [--panel cal-v1]   Per-family results, cost per task and the in-band count
  atif17      <in.json> <out.json>   Convert an ATIF v1.8 trajectory to v1.7

Environment (secrets are read, never printed):
  BUGFARM_GATEWAY_URL         LiteLLM gateway (default http://localhost:4400)
  BUGFARM_CAMPAIGN_KEY_FILE   campaign key file (default .work/calibration/campaign-key.json)
  BUGFARM_STABLEHAND_ENV      a Stablehand .env to read STABLEHAND_API_TOKEN and
                              STABLEHAND_MODEL_GATEWAY_METERING_KEY from
  STABLEHAND_URL              Stablehand API (default http://localhost:3002)
  STABLEHAND_API_TOKEN, BUGFARM_GATEWAY_METERING_KEY   override the .env values
  BUGFARM_URL, BUGFARM_INGEST_TOKEN   the board's ingest API (no board writes without them)
`;

interface CliEnv {
  gatewayUrl: string;
  keyFile: string;
  admin?: StablehandAdmin;
  meteringKey?: string;
  board: BoardSink;
}

function cliEnv(panelId: string): CliEnv {
  const env = process.env;
  const dot = env.BUGFARM_STABLEHAND_ENV && fileExists(env.BUGFARM_STABLEHAND_ENV) ? readDotenv(env.BUGFARM_STABLEHAND_ENV) : {};
  const token = env.STABLEHAND_API_TOKEN ?? dot.STABLEHAND_API_TOKEN;
  const boardUrl = env.BUGFARM_URL;
  const boardToken = env.BUGFARM_INGEST_TOKEN;
  return {
    gatewayUrl: env.BUGFARM_GATEWAY_URL ?? 'http://localhost:4400',
    keyFile: env.BUGFARM_CAMPAIGN_KEY_FILE ?? join(CALIBRATION_DIR, 'campaign-key.json'),
    admin: token ? { url: env.STABLEHAND_URL ?? 'http://localhost:3002', token } : undefined,
    meteringKey: env.BUGFARM_GATEWAY_METERING_KEY ?? dot.STABLEHAND_MODEL_GATEWAY_METERING_KEY,
    board: boardUrl && boardToken ? new BoardClient({ url: boardUrl, token: boardToken, outbox: join(panelDir(panelId), 'board-outbox.jsonl') }) : new NullBoard(),
  };
}

function gatewayContext(e: CliEnv, keyFile = e.keyFile): GatewayContext {
  const key = readCampaignKey(keyFile);
  return {
    url: e.gatewayUrl,
    key,
    spendLog: e.meteringKey ? new SpendLog({ gatewayUrl: e.gatewayUrl, meteringKey: e.meteringKey, keyAlias: key.key_alias, sinceMs: key.created_at || Date.now() - 30 * 86_400_000 }) : undefined,
  };
}

function taskDirsFrom(args: ReturnType<typeof parseArgs>): string[] {
  const dirs = args._.slice(1).map((d) => resolve(d));
  if (typeof args['tasks-dir'] === 'string') {
    const root = resolve(args['tasks-dir']);
    for (const n of readdirSync(root).sort()) if (fileExists(join(root, n, 'task.toml'))) dirs.push(join(root, n));
  }
  if (!dirs.length) throw new Error(`no tasks given\n\n${USAGE}`);
  return dirs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const panelId = typeof args.panel === 'string' && !args.panel.endsWith('.json') ? args.panel : typeof args['panel-id'] === 'string' ? args['panel-id'] : 'cal-v1';
  const e = cliEnv(panelId);
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  const num = (k: string) => {
    const v = str(k);
    if (v === undefined) throw new Error(`--${k} is required\n\n${USAGE}`);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a non-negative number`);
    return n;
  };

  switch (cmd) {
    case 'routes': {
      const panel = defaultPanel(panelId);
      const key = readCampaignKey(str('key-file') ?? e.keyFile);
      const models = str('models')?.split(',') ?? Object.keys(panel.models);
      const res = await checkRoutes(e.gatewayUrl, key.key, models, { completionTokensModels: panel.completion_tokens_models, tag: 'routes' });
      for (const r of res) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.model.padEnd(20)} ${String(r.seconds).padStart(5)}s ${r.ok ? `$${(r.cost_usd ?? 0).toFixed(6)}` : `${r.status ?? ''} ${r.detail ?? ''}`}`);
      break;
    }
    case 'freeze': {
      const base = str('panel')?.endsWith('.json') ? readPanelFile(str('panel') as string) : defaultPanel(panelId);
      const key = readCampaignKey(str('key-file') ?? e.keyFile);
      const frozen = await freezePanel(base, { gatewayUrl: e.gatewayUrl, key: key.key });
      console.log(JSON.stringify({ id: frozen.id, sha: frozen.sha, frozen_at: frozen.frozen_at, routes: frozen.routes.map((r) => `${r.ok ? 'ok' : 'FAIL'} ${r.model}`) }, null, 2));
      break;
    }
    case 'mint-key': {
      if (!e.admin) throw new Error('mint-key needs STABLEHAND_API_TOKEN (or BUGFARM_STABLEHAND_ENV)');
      const panel = defaultPanel(panelId);
      const campaign = str('campaign');
      if (!campaign) throw new Error(`--campaign is required\n\n${USAGE}`);
      const keyFile = str('key-file') ?? e.keyFile;
      if (fileExists(keyFile)) throw new Error(`${keyFile} already exists; revoke or move it before minting another key`);
      const models = [...new Set(panel.families.flatMap((f) => [f.cheap, f.strong]).filter((m): m is string => Boolean(m)))];
      const k = await mintCampaignKey(e.admin, { name: str('name') ?? `bugfarm calibration ${campaign}`, tags: { campaign }, models, maxBudgetUsd: num('max-budget'), keyFile });
      console.log(JSON.stringify({ id: k.id, key_alias: k.key_alias, tags: k.tags, models: k.models, max_budget_usd: k.max_budget_usd, key_file: keyFile }, null, 2));
      break;
    }
    case 'one': {
      const panel = loadFrozenPanel(panelId);
      const dir = taskDirsFrom(args)[0];
      const r = await calibrate(dir, panel, num('budget'), { gateway: gatewayContext(e), board: e.board, writeStage: Boolean(args.stage), itemKey: str('item') });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'run': {
      const panel = loadFrozenPanel(panelId);
      const dirs = taskDirsFrom(args);
      const gw = gatewayContext(e);
      const t0 = Date.now();
      const budget = num('budget');
      const campaign = { key: gw.key.tags.campaign ?? gw.key.id, name: str('campaign-name') ?? `Calibration ${panel.id}`, repo: readTaskInfo(dirs[0]).repo, cap_usd: gw.key.max_budget_usd ?? budget };
      const results = await calibrateMany(dirs, panel, { gateway: gw, board: e.board, writeStage: Boolean(args.stage), totalBudget: budget, concurrency: Number(str('concurrency') ?? 6), taskConcurrency: str('task-concurrency') ? Number(str('task-concurrency')) : undefined, campaign });
      // Price everything from the gateway now that the run is over.
      await new Promise((r) => setTimeout(r, 30_000));
      const rec = await reconcile(panel.id, { gateway: gw, admin: e.admin, board: e.board });
      await e.board.write([campaignRow(campaign, rec.stablehand_spend_usd ?? rec.attempts_cost_usd, { status: 'done' })]);
      const fresh = summaries(panel.id).filter((s) => results.some((r) => r.task === s.task));
      const report = { panel: { id: panel.id, sha: panel.sha }, wall_seconds: secs(Date.now() - t0), results: fresh, reconciliation: rec };
      writeJson(join(panelDir(panel.id), `run-${new Date().toISOString().replace(/[:.]/g, '')}.json`), report);
      console.log(reportTable(panel, fresh));
      console.log('');
      console.log(modelTable(panel.id));
      console.log(JSON.stringify(rec, null, 2));
      break;
    }
    case 'reconcile': {
      const r = await reconcile(panelId, { gateway: gatewayContext(e), admin: e.admin, board: e.board });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'board-sync': {
      // Re-send every stored attempt and item to the board (a new or reset board catches up).
      const panel = loadFrozenPanel(panelId);
      const rows: BoardRow[] = [];
      if (fileExists(e.keyFile)) {
        const key = readCampaignKey(e.keyFile);
        const all = summaries(panel.id);
        const spend = all.reduce((s, r) => s + r.cost, 0);
        const repo = all[0] ? readJson<{ task_info: TaskInfo }>(join(taskStoreDir(panel.id, all[0].task), 'summary.json')).task_info.repo : '';
        rows.push(campaignRow({ key: key.tags.campaign ?? key.id, name: str('campaign-name') ?? `Calibration ${panel.id}`, repo, cap_usd: key.max_budget_usd ?? 0 }, spend));
      }
      for (const s of summaries(panel.id)) {
        const info = (readJson<{ task_info: TaskInfo }>(join(taskStoreDir(panel.id, s.task), 'summary.json'))).task_info;
        const store = new AttemptStore(panel.id, s.task);
        rows.push(itemRowFor(panel, info, store, Boolean(args.stage), s.decision === 'screened' ? undefined : { decision: s.decision }));
        for (const a of store.all().filter((x) => x.status === 'done')) rows.push(attemptRow(a));
      }
      await e.board.write(rows);
      console.log(`sent ${rows.length} rows`);
      break;
    }
    case 'task-toml': {
      // Write each decided task's per-family difficulty into its task.toml.
      const panel = loadFrozenPanel(panelId);
      let n = 0;
      for (const s of summaries(panel.id)) {
        if (s.decision === 'screened') continue;
        const info = readJson<{ task_info: TaskInfo }>(join(taskStoreDir(panel.id, s.task), 'summary.json')).task_info;
        if (!fileExists(join(info.dir, 'task.toml'))) continue;
        writeTaskCalibration(info.dir, panel, s);
        n++;
      }
      console.log(`wrote calibration into ${n} task.toml files`);
      break;
    }
    case 'report': {
      const panel = loadFrozenPanel(panelId);
      console.log(reportTable(panel, summaries(panel.id)));
      console.log('');
      console.log(modelTable(panel.id));
      break;
    }
    case 'atif17': {
      const [, input, output] = args._;
      if (!input || !output) throw new Error(`atif17 needs <in> <out>\n\n${USAGE}`);
      const conv = toAtifV17(JSON.parse(readFileSync(input, 'utf8')));
      writeJson(output, conv.trajectory);
      console.log(JSON.stringify({ versions_rewritten: conv.versions_rewritten, audio_parts_replaced: conv.audio_parts_replaced }));
      break;
    }
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    log('error', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
