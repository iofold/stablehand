#!/usr/bin/env node
// Bugfarm benchmark and publish CLI. Run from extensions/bugfarm:
//
//   node --experimental-strip-types bench/cli.ts <command> [options]
//
// See bench/README.md for the method. Secrets are read from the environment or the Stablehand
// .env and never printed.
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, parseArgs, writeJson } from '../pipeline/lib/util.ts';
import { HARBOR_VERSION } from '../pipeline/lib/config.ts';
import { readCampaignKey } from '../pipeline/calibrate-gateway.ts';
import { attemptRow, boardFor, cellRow, statsFor } from './lib/board.ts';
import { ensureCampaign } from './lib/campaign.ts';
import { DEFAULT_CELLS_FILE, HARBOR_PKG_DIR, loadCellsConfig, loadSettings, resolveCell } from './lib/config.ts';
import { reconcile, pricingContext } from './lib/spend.ts';
import type { Api } from './lib/spend.ts';
import { runBench } from './lib/runner.ts';
import { AttemptStore, benchDir, bestCost, definitionPath, loadDefinition, saveDefinition, tasksSha } from './lib/store.ts';
import type { BenchDefinition, TaskSet } from './lib/store.ts';
import { readTask, snapshotTask, taskDirsIn } from './lib/tasks.ts';
import { publish } from './publish/publish.ts';

const USAGE = `usage: bench/cli.ts <command> --bench <id> [options]

  init       --bench <id> --campaign <tag> (--tasks-dir <dir> [--tasks a,b] | <taskDir...>)
             --set accepted|dev_standin [--label "..."] [--note "..."] [--k 3]
             [--cells-file bench/cells.json] [--cells id,id] [--agent-timeout 1200] [--max-cost-per-trial 2]
             Freeze the bench: snapshot the tasks, resolve the cells. Re-running adds new cells
             and refuses to change a task or an existing cell.
  setup      --bench <id> --cap <usd>   Budget policy on the campaign tag (warn 50%/85%, block 100%)
             and a campaign gateway key for the terminus-2 cells (key file 0600, never printed)
  run        --bench <id> [--concurrency 6] [--budget <usd>] [--cells id,id] [--tries n] [--plan]
             Run the missing tries; resumes after a crash or kill without double-counting
  status     --bench <id>               Cells, running trials, spend
  reconcile  --bench <id>               Ledger vs gateway spend log vs Stablehand's campaign budget
  report     --bench <id>               Leaderboard table (markdown) and report.json
  board-sync --bench <id>               Re-send every cell and attempt row to the board
  publish    --bench <id> --out <dir> [--hf-repo org/name] [--dry-run | --push] [--visibility private|public]
             Build the dataset folder, ask a person to approve through Stablehand (request-approval),
             then push to the Hugging Face Hub. Dry run by default. See bench/README.md.

Environment: STABLEHAND_URL (default http://localhost:3002), BUGFARM_STABLEHAND_ENV (a Stablehand
.env to read STABLEHAND_API_TOKEN and the gateway metering key from; default ~/stablehand/.env),
BUGFARM_GATEWAY_URL (default http://localhost:4400), BUGFARM_URL + BUGFARM_INGEST_TOKEN (board),
BUGFARM_BOARD_URL (the board's address for people), BUGFARM_BENCH_WORK (default bench/.work),
BUGFARM_BENCH_HARBOR (default harbor/.venv/bin/harbor).
`;

type Args = ReturnType<typeof parseArgs>;

function str(args: Args, k: string): string | undefined {
  return typeof args[k] === 'string' ? (args[k] as string) : undefined;
}

function num(args: Args, k: string, fallback?: number): number {
  const v = str(args, k);
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`--${k} is required\n\n${USAGE}`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} must be a non-negative number`);
  return n;
}

function list(args: Args, k: string): string[] | undefined {
  const v = str(args, k);
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

function benchId(args: Args): string {
  const id = str(args, 'bench');
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`--bench <id> is required (lowercase letters, digits, . _ -)\n\n${USAGE}`);
  return id;
}

function stablehandApi(): Api | undefined {
  const s = loadSettings();
  return s.stablehandToken ? { url: s.stablehandUrl, token: s.stablehandToken } : undefined;
}

function keyFileFor(id: string): string {
  return join(benchDir(id), 'campaign-key.json');
}

function harborPkgVersion(): string | undefined {
  try {
    return /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(HARBOR_PKG_DIR, 'pyproject.toml'), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

function init(args: Args): void {
  const id = benchId(args);
  const cfg = loadCellsConfig(str(args, 'cells-file') ?? DEFAULT_CELLS_FILE);
  const wanted = list(args, 'cells');
  const specs = cfg.cells.filter((c) => (wanted ? wanted.includes(c.id) : c.enabled !== false));
  if (wanted) for (const w of wanted) if (!cfg.cells.some((c) => c.id === w)) throw new Error(`no cell ${w} in the cells file`);
  const cells = specs.map((c) => resolveCell(cfg, c, { agent_timeout_sec: str(args, 'agent-timeout') ? num(args, 'agent-timeout') : undefined, max_cost_usd_per_trial: str(args, 'max-cost-per-trial') ? num(args, 'max-cost-per-trial') : undefined }));

  let dirs = args._.slice(1).map((d) => resolve(d));
  const root = str(args, 'tasks-dir');
  if (root) {
    const only = list(args, 'tasks');
    dirs = dirs.concat(taskDirsIn(root).filter((d) => !only || only.some((n) => d.endsWith(`/${n}`))));
  }
  const existing = existsSync(definitionPath(id)) ? loadDefinition(id) : undefined;
  if (!existing) {
    if (!dirs.length) throw new Error(`no tasks given\n\n${USAGE}`);
    const campaign = str(args, 'campaign');
    if (!campaign) throw new Error(`--campaign is required\n\n${USAGE}`);
    const kind = str(args, 'set');
    if (kind !== 'accepted' && kind !== 'dev_standin') throw new Error('--set must be accepted or dev_standin');
    const tasks = dirs.map((d) => {
      const name = d.split('/').pop() as string;
      const dst = join(benchDir(id), 'tasks', name);
      snapshotTask(d, dst);
      return readTask(dst);
    });
    const repo = tasks[0].repo;
    const label = str(args, 'label') ?? (kind === 'accepted' ? `${tasks.length} accepted ${repo} tasks` : `Dev stand-in: ${tasks.length} ${repo} tasks, not calibration-accepted`);
    const taskSet: TaskSet = { kind, label, note: str(args, 'note'), source_dir: root ? resolve(root) : undefined };
    const def: BenchDefinition = {
      id,
      campaign,
      repo,
      created_at: Date.now(),
      k: num(args, 'k', cfg.defaults.k),
      task_set: taskSet,
      tasks,
      cells,
      tasks_sha: tasksSha(tasks),
      harbor_version: HARBOR_VERSION,
      stablehand_harbor_version: harborPkgVersion(),
    };
    saveDefinition(def);
    console.log(JSON.stringify({ created: id, campaign, k: def.k, task_set: taskSet, tasks: tasks.map((t) => `${t.item} (${t.name})`), cells: cells.map((c) => `${c.id} [${c.sha}]`) }, null, 2));
    return;
  }
  // Existing bench: tasks are fixed; cells can be added, never changed.
  if (dirs.length) {
    const names = dirs.map((d) => d.split('/').pop()).sort().join(',');
    if (names !== existing.tasks.map((t) => t.name).sort().join(',')) throw new Error(`bench ${id} already measures other tasks; use a new bench id`);
  }
  const added: string[] = [];
  for (const c of cells) {
    const old = existing.cells.find((x) => x.id === c.id);
    if (old && old.sha !== c.sha) throw new Error(`cell ${c.id} changed since bench ${id} was frozen (${old.sha} -> ${c.sha}); give it a new id or start a new bench`);
    // Notes and labels are display only (not hashed): refresh them.
    if (old) Object.assign(old, { notes: c.notes, harness_label: c.harness_label });
    if (!old) {
      existing.cells.push(c);
      added.push(c.id);
    }
  }
  if (str(args, 'k') && num(args, 'k') > existing.k) existing.k = num(args, 'k');
  saveDefinition(existing);
  console.log(JSON.stringify({ bench: id, added_cells: added, k: existing.k, cells: existing.cells.map((c) => c.id) }, null, 2));
}

async function setup(args: Args): Promise<void> {
  const def = loadDefinition(benchId(args));
  const a = stablehandApi();
  if (!a) throw new Error('setup needs STABLEHAND_API_TOKEN (or BUGFARM_STABLEHAND_ENV)');
  const models = [...new Set(def.cells.filter((c) => c.agent === 'terminus-2').map((c) => c.model))];
  const res = await ensureCampaign(a, { campaign: def.campaign, capUsd: num(args, 'cap'), models, keyFile: keyFileFor(def.id) });
  if (existsSync(keyFileFor(def.id))) chmodSync(keyFileFor(def.id), 0o600);
  console.log(JSON.stringify(res, null, 2));
}

function launchEnv(def: BenchDefinition) {
  const s = loadSettings();
  let campaignKey: string | undefined;
  if (def.cells.some((c) => c.agent === 'terminus-2')) {
    if (!existsSync(keyFileFor(def.id))) throw new Error(`no campaign key for ${def.id}; run \`cli.ts setup --bench ${def.id} --cap <usd>\` first`);
    campaignKey = readCampaignKey(keyFileFor(def.id)).key;
  }
  return { harborBin: s.harborBin, gatewayUrl: s.gatewayUrl, campaignKey, stablehandUrl: s.stablehandUrl, stablehandToken: s.stablehandToken };
}

function pricing(def: BenchDefinition) {
  const s = loadSettings();
  return pricingContext({ stablehand: stablehandApi(), gatewayUrl: s.gatewayUrl, meteringKey: s.meteringKey, campaignKeyFile: existsSync(keyFileFor(def.id)) ? keyFileFor(def.id) : undefined });
}

async function run(args: Args): Promise<void> {
  const def = loadDefinition(benchId(args));
  const s = loadSettings();
  if (def.cells.some((c) => c.agent === 'stablehand') && !existsSync(s.harborBin)) throw new Error(`no Harbor at ${s.harborBin}; run \`uv sync\` in ${HARBOR_PKG_DIR}`);
  const cap = await capFor(def);
  const budget = str(args, 'budget') ? num(args, 'budget') : cap;
  if (budget === undefined) throw new Error('no campaign budget found; run setup first or pass --budget');
  if (cap !== undefined && budget > cap) throw new Error(`--budget $${budget} is above the campaign cap $${cap}`);
  const cfgDefaults = loadCellsConfig().defaults;
  const store = new AttemptStore(def.id);
  const summary = await runBench(def, store, launchEnv(def), pricing(def), boardFor(def.id, s.boardUrl, s.boardToken), {
    concurrency: num(args, 'concurrency', cfgDefaults.concurrency),
    budgetUsd: budget,
    reserveFactor: cfgDefaults.reserve_factor,
    cells: list(args, 'cells'),
    maxTries: str(args, 'tries') ? num(args, 'tries') : undefined,
    plan: Boolean(args.plan),
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!args.plan) console.log(reportTable(def, store));
}

async function capFor(def: BenchDefinition): Promise<number | undefined> {
  const a = stablehandApi();
  if (!a) return undefined;
  const { findBudgetPolicy } = await import('./lib/spend.ts');
  const p = await findBudgetPolicy(a, def.campaign);
  return p?.doc?.limits?.costUsd;
}

export function reportTable(def: BenchDefinition, store: AttemptStore): string {
  const all = store.all();
  const rows = def.cells
    .map((c) => ({ c, s: statsFor(def, c, all) }))
    .sort((x, y) => (y.s.pass_at_1 ?? -1) - (x.s.pass_at_1 ?? -1) || (x.s.usd_per_solve ?? Infinity) - (y.s.usd_per_solve ?? Infinity));
  const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
  const lines = [
    `**${def.id}** · ${def.task_set.label} · k=${def.k}`,
    '',
    '| # | cell | pass@1 | 95% CI | solved | tasks solved | errors | $ per solve | $ total | median agent time |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  rows.forEach(({ c, s }, i) => {
    lines.push(`| ${i + 1} | ${c.id} | ${pct(s.pass_at_1)} | ${s.ci_low === null ? '–' : `${pct(s.ci_low)}–${pct(s.ci_high)}`} | ${s.solved}/${s.attempts} | ${s.tasks_solved}/${s.tasks} | ${s.errors} | ${s.usd_per_solve === null ? '–' : `$${s.usd_per_solve.toFixed(2)}`} | $${s.cost_usd.toFixed(2)} | ${s.median_seconds === null ? '–' : `${Math.round(s.median_seconds)} s`} |`);
  });
  const voided = all.filter((a) => a.status === 'void');
  const total = all.filter((a) => a.status !== 'running').reduce((s, a) => s + bestCost(a), 0);
  lines.push('', `Spend: $${total.toFixed(4)} over ${all.filter((a) => a.status === 'done').length} attempts${voided.length ? ` and ${voided.length} voided executions` : ''}.`);
  return lines.join('\n');
}

function status(args: Args): void {
  const def = loadDefinition(benchId(args));
  const store = new AttemptStore(def.id);
  console.log(reportTable(def, store));
  const running = store.all().filter((a) => a.status === 'running');
  if (running.length) {
    console.log('\nRunning:');
    for (const a of running) console.log(`  ${a.job_name}  pid ${a.pid ?? '?'}  ${Math.round((Date.now() - a.started_at) / 1000)} s`);
  }
}

async function doReconcile(args: Args): Promise<void> {
  const def = loadDefinition(benchId(args));
  const store = new AttemptStore(def.id);
  const r = await reconcile(store, def, pricing(def), loadSettings().runtimeKey);
  writeJson(join(benchDir(def.id), 'reconciliation.json'), r);
  const s = loadSettings();
  const board = boardFor(def.id, s.boardUrl, s.boardToken);
  const all = store.all();
  await board.write([...def.cells.map((c) => cellRow(def, c, statsFor(def, c, all))), ...all.filter((a) => a.status === 'done').map(attemptRow)]);
  console.log(JSON.stringify(r, null, 2));
}

function report(args: Args): void {
  const def = loadDefinition(benchId(args));
  const store = new AttemptStore(def.id);
  const all = store.all();
  const cells = def.cells.map((c) => ({ cell: c.id, harness: c.harness, model: c.model, runner: c.harness_label, notes: c.notes, ...statsFor(def, c, all) }));
  writeJson(join(benchDir(def.id), 'report.json'), { bench: def.id, campaign: def.campaign, task_set: def.task_set, k: def.k, tasks: def.tasks.map((t) => t.item), cells, at: Date.now() });
  console.log(reportTable(def, store));
}

async function boardSync(args: Args): Promise<void> {
  const def = loadDefinition(benchId(args));
  const s = loadSettings();
  if (!s.boardUrl || !s.boardToken) throw new Error('board-sync needs BUGFARM_URL and BUGFARM_INGEST_TOKEN');
  const store = new AttemptStore(def.id);
  const all = store.all();
  const rows = [...def.cells.map((c) => cellRow(def, c, statsFor(def, c, all))), ...all.filter((a) => a.status === 'done').map(attemptRow)];
  await boardFor(def.id, s.boardUrl, s.boardToken).write(rows);
  console.log(`sent ${rows.length} rows`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args._[0]) {
    case 'init':
      return init(args);
    case 'setup':
      return setup(args);
    case 'run':
      return run(args);
    case 'status':
      return status(args);
    case 'reconcile':
      return doReconcile(args);
    case 'report':
      return report(args);
    case 'board-sync':
      return boardSync(args);
    case 'publish':
      return publish(args);
    default:
      console.log(USAGE);
      if (args._[0]) process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    log('error', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
