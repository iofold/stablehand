// Harbor task identity for the benchmark: what the task is, which board item it belongs to, and
// content hashes of what the solver is told, how it is graded and the environment it runs in.
// The benchmark snapshots each task when the bench is frozen, so a later rewrite of the source
// task (a new instruction, a calibration receipt) never changes a bench in flight.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { num, parseToml, str, strArr, tableAt } from './toml.ts';
import type { TomlTable } from './toml.ts';

export interface FamilyDifficulty {
  model?: string;
  passes: number;
  attempts: number;
  errors?: number;
  state?: string;
}

export interface TaskInfo {
  /** Directory name, e.g. fastapi-f90d036938. */
  name: string;
  /** Board item key, e.g. fastapi@f90d0369. */
  item: string;
  dir: string;
  repo: string;
  sha: string;
  title: string;
  fix_date?: string;
  instruction_status?: string;
  instruction_sha: string;
  verifier_sha: string;
  environment_sha: string;
  /** Selection receipts written by calibration, if any. */
  calibration?: { panel?: string; panel_sha?: string; decision?: string; attempts?: number; cost_usd?: number; calibrated_at?: string };
  difficulty: Record<string, FamilyDifficulty>;
  fail_to_pass: string[];
  pass_to_pass_count?: number;
  source_files: string[];
  test_files: string[];
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
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

export function treeSha(root: string, paths: string[]): string {
  const h = createHash('sha256');
  for (const p of paths) h.update(relative(root, p)).update('\0').update(readFileSync(p)).update('\0');
  return h.digest('hex').slice(0, 16);
}

/** task.toml without the calibration block, which calibration rewrites after the fact. */
function tomlForIdentity(text: string): string {
  return text.replace(/# --- bugfarm calibration[\s\S]*?# --- end bugfarm calibration ---\n?/, '');
}

export function itemKeyOf(name: string, sha: string): string {
  const slug = name.replace(/-[0-9a-f]{10}$/, '');
  return sha ? `${slug}@${sha.slice(0, 8)}` : name;
}

export function readTask(taskDir: string): TaskInfo {
  const dir = resolve(taskDir);
  const tomlPath = join(dir, 'task.toml');
  if (!existsSync(tomlPath)) throw new Error(`${dir} is not a Harbor task (no task.toml)`);
  const text = readFileSync(tomlPath, 'utf8');
  const toml = parseToml(text);
  const meta = tableAt(toml, 'metadata.bugfarm');
  const cal = tableAt(toml, 'metadata.bugfarm.calibration');
  const diff = tableAt(toml, 'metadata.bugfarm.difficulty');
  const difficulty: Record<string, FamilyDifficulty> = {};
  for (const [family, value] of Object.entries(diff ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const t = value as TomlTable;
    difficulty[family] = { model: str(t, 'model'), passes: num(t, 'passes') ?? 0, attempts: num(t, 'attempts') ?? 0, errors: num(t, 'errors'), state: str(t, 'state') };
  }
  const name = basename(dir);
  const sha = str(meta, 'fix_sha') ?? '';
  const envFiles = ['Dockerfile', 'docker-compose.yaml'].map((f) => join(dir, 'environment', f)).filter((p) => existsSync(p));
  const h = createHash('sha256').update(tomlForIdentity(text));
  return {
    name,
    item: itemKeyOf(name, sha),
    dir,
    repo: str(meta, 'repo') ?? 'unknown/unknown',
    sha,
    title: str(meta, 'fix_subject') ?? name,
    fix_date: str(meta, 'fix_date'),
    instruction_status: str(tableAt(toml, 'metadata'), 'instruction_status'),
    instruction_sha: treeSha(dir, [join(dir, 'instruction.md')]),
    verifier_sha: treeSha(dir, filesUnder(join(dir, 'tests'))),
    environment_sha: `${treeSha(dir, envFiles)}.${h.digest('hex').slice(0, 8)}`,
    calibration: cal
      ? { panel: str(cal, 'panel'), panel_sha: str(cal, 'panel_sha'), decision: str(cal, 'decision'), attempts: num(cal, 'attempts'), cost_usd: num(cal, 'cost_usd'), calibrated_at: str(cal, 'calibrated_at') }
      : undefined,
    difficulty,
    fail_to_pass: strArr(meta, 'fail_to_pass'),
    pass_to_pass_count: num(meta, 'pass_to_pass_count'),
    source_files: strArr(meta, 'source_files'),
    test_files: strArr(meta, 'test_files'),
  };
}

/** Task dirs under a dataset dir (each child with a task.toml), sorted by name. */
export function taskDirsIn(root: string): string[] {
  const abs = resolve(root);
  return readdirSync(abs)
    .sort()
    .map((n) => join(abs, n))
    .filter((p) => existsSync(join(p, 'task.toml')));
}

/** Copy a task into the bench's own snapshot directory (once). */
export function snapshotTask(src: string, dst: string): void {
  if (existsSync(join(dst, 'task.toml'))) return;
  cpSync(src, dst, { recursive: true, dereference: false, preserveTimestamps: true });
}
