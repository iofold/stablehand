// The dataset folder Bugfarm publishes:
//
//   README.md                    dataset card (rendered by card.ts; the approval is added after it)
//   tasks/<task>/                the Harbor tasks, exactly as the benchmark measured them
//   data/swebench.jsonl          one SWE-bench-style row per task, for trainers that don't read Harbor
//   leaderboard.json             the benchmark's cells
//   spend/ledger.json, .csv      cost per task and per campaign
//   spend/reconciliation.json    the ledger against the gateway's spend log and Stablehand's budget
//   provenance/manifest.json     sha256 of every file above; its hash is the dataset sha
//   provenance/approval.json     who approved publishing, when and why (after approval)
//
// The dataset sha covers everything except the card, the approval and the reconciliation snapshot,
// so an approval is bound to exact contents: change a task, a result or a ledger figure and the old
// approval no longer applies. The snapshot is left out because asking for approval is itself a
// (tiny) tagged turn that moves the campaign budget, and because it carries the time it was taken.
// The card renders it, and it is refreshed on every build.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { run } from '../../pipeline/lib/util.ts';
import { statsFor } from '../lib/board.ts';
import type { ResolvedCell } from '../lib/config.ts';
import type { Reconciliation } from '../lib/spend.ts';
import type { CellStats } from '../lib/stats.ts';
import { benchDir, bestCost } from '../lib/store.ts';
import type { AttemptStore, BenchDefinition } from '../lib/store.ts';
import type { TaskInfo } from '../lib/tasks.ts';

export const CARD = 'README.md';
export const APPROVAL = 'provenance/approval.json';
export const MANIFEST = 'provenance/manifest.json';
export const RECONCILIATION = 'spend/reconciliation.json';

export interface LeaderboardCell extends CellStats {
  cell: string;
  harness: string;
  model: string;
  family: string;
  runner: string;
  notes: string[];
}

export interface SelectionSpend {
  /** Campaign tag of the calibration campaign, if given. */
  campaign?: string;
  /** Calibration receipts on these tasks (task.toml). */
  tasks_usd: number;
  /** The calibration campaign's whole spend, as Stablehand recorded it for its campaign keys. */
  campaign_total_usd: number | null;
  campaign_calls: number | null;
  /** The same campaign keys' rows in the gateway spend log, read independently. */
  gateway_usd: number | null;
  keys: string[];
}

export interface AuthoringSpend {
  campaign?: string;
  /** Floor-agent turns (Scout, Env builder, Writer) tagged with the factory campaign. */
  total_usd: number | null;
  by_item: Record<string, number>;
  note: string;
}

export interface LedgerTask {
  task: string;
  item: string;
  authoring_usd: number | null;
  selection_usd: number | null;
  measurement_usd: number;
  total_usd: number;
}

export interface Ledger {
  currency: 'USD';
  tasks: LedgerTask[];
  measurement: { campaign: string; attempts: number; voided_executions: number; total_usd: number; by_cell: Record<string, { attempts: number; usd: number }> };
  selection: SelectionSpend | null;
  authoring: AuthoringSpend | null;
  /** Calibration spent on candidates that are not in this dataset (rejected or undecided). */
  other_selection_usd: number | null;
  totals: { authoring_usd: number | null; selection_usd: number | null; measurement_usd: number; campaign_usd: number };
  reconciliation: Reconciliation | null;
}

export interface DatasetModel {
  def: BenchDefinition;
  tasks: TaskInfo[];
  cells: LeaderboardCell[];
  ledger: Ledger;
  rows: Array<Record<string, unknown>>;
  license: { repo: string; file: string | null; first_line: string | null };
  sha: string;
  files: number;
  bytes: number;
  built_at: number;
  target: { repo: string | null; visibility: 'private' | 'public' };
  boardUrl?: string;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const rel = relative(root, p);
      if (skip(rel)) continue;
      if (statSync(p).isDirectory()) go(p);
      else out.push(rel);
    }
  };
  go(root);
  return out;
}

function stripCanary(text: string): { text: string; canary: string | null } {
  const m = /^<!--\s*bugfarm-canary GUID ([0-9a-f-]+)\s*-->\n?/.exec(text);
  return m ? { text: text.slice(m[0].length), canary: m[1] } : { text, canary: null };
}

/** `diff --git a/<f> b/<f>` for the hidden test files, from what the solver sees to what the verifier runs. */
async function testPatchFor(taskDir: string): Promise<string> {
  const agentRepo = join(taskDir, 'environment', 'bugfarm-repo');
  const hiddenRoot = join(taskDir, 'tests', 'hidden');
  const hidden = existsSync(hiddenRoot) ? walk(hiddenRoot) : [];
  const deletedPath = join(taskDir, 'tests', 'deleted_tests.txt');
  const deleted = existsSync(deletedPath) ? readFileSync(deletedPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (!hidden.length && !deleted.length) return '';
  const tmp = mkdtempSync(join(tmpdir(), 'bugfarm-testpatch-'));
  try {
    for (const f of [...hidden, ...deleted]) {
      if (existsSync(join(agentRepo, f))) {
        mkdirSync(dirname(join(tmp, 'old', f)), { recursive: true });
        cpSync(join(agentRepo, f), join(tmp, 'old', f));
      }
    }
    for (const f of hidden) {
      mkdirSync(dirname(join(tmp, 'new', f)), { recursive: true });
      cpSync(join(hiddenRoot, f), join(tmp, 'new', f));
    }
    mkdirSync(join(tmp, 'old'), { recursive: true });
    mkdirSync(join(tmp, 'new'), { recursive: true });
    const r = await run('git', ['diff', '--no-index', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', 'old', 'new'], { cwd: tmp, env: { GIT_CEILING_DIRECTORIES: tmp } });
    if (r.code !== 0 && r.code !== 1) throw new Error(`git diff failed: ${r.stderr.slice(0, 300)}`);
    return r.stdout
      .split('\n')
      .map((line) => line.replace(/^(diff --git )a\/old\/(.*) b\/new\//, '$1a/$2 b/').replace(/^(--- )a\/old\//, '$1a/').replace(/^(\+\+\+ )b\/new\//, '$1b/').replace(/^(diff --git )a\/new\/(.*) b\/new\//, '$1a/$2 b/').replace(/^(diff --git )a\/old\/(.*) b\/old\//, '$1a/$2 b/'))
      .join('\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** One SWE-bench-style row per task: the pipeline's row when there is one, refreshed from the task as measured. */
export async function swebenchRow(t: TaskInfo, source: Map<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
  const base = source.get(`bugfarm/${t.name}`) ?? source.get(t.name) ?? {};
  const instruction = stripCanary(readFileSync(join(t.dir, 'instruction.md'), 'utf8'));
  const expectedPath = join(t.dir, 'tests', 'expected.json');
  const expected = existsSync(expectedPath) ? (JSON.parse(readFileSync(expectedPath, 'utf8')) as { fail_to_pass?: string[]; pass_to_pass?: string[] }) : {};
  const patchPath = join(t.dir, 'solution', 'fix.patch');
  const toml = readFileSync(join(t.dir, 'task.toml'), 'utf8');
  const field = (k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];
  return {
    instance_id: base.instance_id ?? `${t.repo.replace('/', '__')}-${t.sha.slice(0, 12)}`,
    repo: t.repo,
    base_commit: base.base_commit ?? field('buggy_base') ?? null,
    fix_commit: t.sha,
    created_at: base.created_at ?? t.fix_date ?? null,
    problem_statement: instruction.text,
    hints_text: '',
    patch: existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : base.patch ?? '',
    test_patch: base.test_patch ?? (await testPatchFor(t.dir)),
    FAIL_TO_PASS: expected.fail_to_pass ?? t.fail_to_pass,
    PASS_TO_PASS: expected.pass_to_pass ?? base.PASS_TO_PASS ?? [],
    image_name: base.image_name ?? field('env_image') ?? null,
    environment_setup_commit: base.environment_setup_commit ?? field('env_head') ?? field('buggy_base') ?? null,
    buggy_state: base.buggy_state ?? null,
    harbor_task: `tasks/${t.name}`,
    bugfarm_item: t.item,
    instruction_status: t.instruction_status ?? null,
    canary: instruction.canary,
    difficulty: t.difficulty,
    calibration_decision: t.calibration?.decision ?? null,
  };
}

function detectLicense(t: TaskInfo): DatasetModel['license'] {
  const repoDir = join(t.dir, 'environment', 'bugfarm-repo');
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING']) {
    const p = join(repoDir, name);
    if (existsSync(p)) {
      const first = readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).find(Boolean) ?? null;
      return { repo: t.repo, file: name, first_line: first };
    }
  }
  return { repo: t.repo, file: null, first_line: null };
}

export function leaderboardCells(def: BenchDefinition, store: AttemptStore): LeaderboardCell[] {
  const all = store.all();
  return def.cells
    .map((c: ResolvedCell) => ({ cell: c.id, harness: c.harness as string, model: c.model, family: c.family, runner: c.harness_label, notes: c.notes, ...statsFor(def, c, all) }))
    .sort((a, b) => (b.pass_at_1 ?? -1) - (a.pass_at_1 ?? -1) || (a.usd_per_solve ?? Infinity) - (b.usd_per_solve ?? Infinity));
}

export function buildLedger(def: BenchDefinition, store: AttemptStore, rec: Reconciliation | null, selection: SelectionSpend | null, authoring: AuthoringSpend | null): Ledger {
  const all = store.all().filter((a) => a.status !== 'running');
  const r2 = (x: number) => Math.round(x * 1e6) / 1e6;
  const tasks: LedgerTask[] = def.tasks.map((t) => {
    const measurement = r2(all.filter((a) => a.task === t.name).reduce((s, a) => s + bestCost(a), 0));
    const sel = t.calibration?.cost_usd ?? null;
    const auth = authoring ? authoring.by_item[t.item] ?? 0 : null;
    return { task: t.name, item: t.item, authoring_usd: auth, selection_usd: sel, measurement_usd: measurement, total_usd: r2(measurement + (sel ?? 0) + (auth ?? 0)) };
  });
  const byCell: Record<string, { attempts: number; usd: number }> = {};
  for (const a of all) {
    const c = (byCell[a.cell] ??= { attempts: 0, usd: 0 });
    c.attempts++;
    c.usd = r2(c.usd + bestCost(a));
  }
  const measurement = r2(all.reduce((s, a) => s + bestCost(a), 0));
  const selectionUsd = selection ? selection.campaign_total_usd ?? selection.tasks_usd : null;
  const otherSelection = selection?.campaign_total_usd !== null && selection?.campaign_total_usd !== undefined ? r2(Math.max(0, selection.campaign_total_usd - selection.tasks_usd)) : null;
  const authoringUsd = authoring?.total_usd ?? null;
  return {
    currency: 'USD',
    tasks,
    measurement: { campaign: def.campaign, attempts: all.filter((a) => a.status === 'done').length, voided_executions: all.filter((a) => a.status === 'void').length, total_usd: measurement, by_cell: byCell },
    selection,
    authoring,
    other_selection_usd: otherSelection,
    totals: { authoring_usd: authoringUsd, selection_usd: selectionUsd, measurement_usd: measurement, campaign_usd: r2(measurement + (selectionUsd ?? 0) + (authoringUsd ?? 0)) },
    reconciliation: rec,
  };
}

function csv(ledger: Ledger): string {
  const q = (v: unknown) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = ['task,item,authoring_usd,selection_usd,measurement_usd,total_usd'];
  for (const t of ledger.tasks) lines.push([t.task, t.item, t.authoring_usd, t.selection_usd, t.measurement_usd, t.total_usd].map(q).join(','));
  lines.push(['campaign total', '', ledger.totals.authoring_usd, ledger.totals.selection_usd, ledger.totals.measurement_usd, ledger.totals.campaign_usd].map(q).join(','));
  return lines.join('\n') + '\n';
}

export interface BuildOptions {
  out: string;
  swebenchSources: string[];
  reconciliation: Reconciliation | null;
  selection: SelectionSpend | null;
  authoring: AuthoringSpend | null;
  target: DatasetModel['target'];
  boardUrl?: string;
}

/** Write everything but the card, and return the model the card is rendered from. */
export async function buildDataset(def: BenchDefinition, store: AttemptStore, opts: BuildOptions): Promise<DatasetModel> {
  const out = opts.out;
  // Rebuild from scratch, keeping only the publish state and an approval already given.
  if (existsSync(out)) {
    for (const n of readdirSync(out)) if (n !== '.publish' && n !== 'provenance') rmSync(join(out, n), { recursive: true, force: true });
    if (existsSync(join(out, MANIFEST))) rmSync(join(out, MANIFEST));
  }
  mkdirSync(join(out, 'tasks'), { recursive: true });
  for (const t of def.tasks) {
    const src = join(benchDir(def.id), 'tasks', t.name);
    cpSync(src, join(out, 'tasks', t.name), { recursive: true });
    rmSync(join(out, 'tasks', t.name, 'environment', 'bugfarm-repo', '.git'), { recursive: true, force: true });
  }
  const source = new Map<string, Record<string, unknown>>();
  for (const p of opts.swebenchSources) if (existsSync(p)) for (const row of readJsonl(p)) source.set(String(row.harbor_task ?? row.instance_id), row);
  const tasks = def.tasks.map((t) => ({ ...t, dir: join(out, 'tasks', t.name) }));
  const rows: Array<Record<string, unknown>> = [];
  for (const t of tasks) rows.push(await swebenchRow(t, source));
  mkdirSync(join(out, 'data'), { recursive: true });
  writeFileSync(join(out, 'data', 'swebench.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const cells = leaderboardCells(def, store);
  writeFileSync(join(out, 'leaderboard.json'), JSON.stringify({ bench: def.id, campaign: def.campaign, task_set: def.task_set, k: def.k, method: 'pass@1 = mean over tasks of passing tries / tries; 95% percentile bootstrap over tasks, 10,000 resamples; tries a provider failed are re-run, remaining errors count as unsolved; $ per solve = cell spend / passing tries, gateway-priced', cells }, null, 2) + '\n');

  const ledger = buildLedger(def, store, opts.reconciliation, opts.selection, opts.authoring);
  mkdirSync(join(out, 'spend'), { recursive: true });
  writeFileSync(join(out, 'spend', 'ledger.json'), JSON.stringify({ ...ledger, reconciliation: undefined }, null, 2) + '\n');
  writeFileSync(join(out, 'spend', 'ledger.csv'), csv(ledger));
  writeFileSync(join(out, RECONCILIATION), JSON.stringify(ledger.reconciliation, null, 2) + '\n');

  const files = walk(out, (rel) => rel === '.publish' || rel === CARD || rel === APPROVAL || rel === MANIFEST || rel === RECONCILIATION);
  const manifest = files.map((f) => ({ path: f, sha256: sha256File(join(out, f)), bytes: statSync(join(out, f)).size }));
  const sha = createHash('sha256').update(manifest.map((m) => `${m.sha256}  ${m.path}`).join('\n')).digest('hex');
  mkdirSync(join(out, 'provenance'), { recursive: true });
  writeFileSync(join(out, MANIFEST), JSON.stringify({ dataset_sha256: sha, bench: def.id, campaign: def.campaign, tasks_sha: def.tasks_sha, harbor_version: def.harbor_version, stablehand_harbor_version: def.stablehand_harbor_version ?? null, files: manifest }, null, 2) + '\n');
  return {
    def,
    tasks,
    cells,
    ledger,
    rows,
    license: detectLicense(tasks[0]),
    sha,
    files: manifest.length + 2,
    bytes: manifest.reduce((s, m) => s + m.bytes, 0),
    built_at: Date.now(),
    target: opts.target,
    boardUrl: opts.boardUrl,
  };
}
