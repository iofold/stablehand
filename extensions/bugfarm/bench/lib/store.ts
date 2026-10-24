// The bench on disk: a frozen definition (task set, cells, k) and one record per attempt.
//
//   <work>/<bench>/bench.json                      definition, frozen at `init`
//   <work>/<bench>/tasks/<task>/                   snapshot of each task, measured as-is
//   <work>/<bench>/attempts/<cell>/<task>/t01.json the attempt that counts for (cell, task, try 1)
//   <work>/<bench>/attempts/<cell>/<task>/t01.void-1.json  an execution our own crash interrupted
//   <work>/<bench>/jobs/<job>/                     Harbor job dirs, configs and logs
//
// A record is written before its Harbor process starts and again when it finishes, so a killed
// runner knows what was in flight. Exactly one record per (cell, task, try) counts toward the
// cell; an execution interrupted by the runner itself (not by the agent) is kept as `void` for the
// spend ledger and the try runs again.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, readJson, writeJson } from '../../pipeline/lib/util.ts';
import { BENCH_WORK, cellSlug, sha16 } from './config.ts';
import type { ResolvedCell } from './config.ts';
import type { TaskInfo } from './tasks.ts';
import type { Outcome } from './stats.ts';

export type TaskSetKind = 'accepted' | 'dev_standin';

export interface TaskSet {
  kind: TaskSetKind;
  /** Short label for the board and the card, e.g. "Dev stand-in: 12 control-passing fastapi tasks". */
  label: string;
  note?: string;
  source_dir?: string;
}

export interface BenchDefinition {
  id: string;
  campaign: string;
  repo: string;
  created_at: number;
  k: number;
  task_set: TaskSet;
  tasks: TaskInfo[];
  cells: ResolvedCell[];
  /** Hash of the tasks' identities; cells are hashed one by one, so cells can be added later. */
  tasks_sha: string;
  harbor_version: string;
  stablehand_harbor_version?: string;
}

export type CostState = 'pending' | 'estimated' | 'turn' | 'gateway';

export interface StablehandTurnRef {
  agent_id?: string;
  turn_id?: string;
  conversation_id?: string;
  gateway_correlation_id?: string;
  status?: string;
  stop_reason?: unknown;
  cost_coverage?: string;
}

export interface BenchAttempt {
  /** Unique per execution; it is also the `bugfarm_attempt` spend-log tag of terminus-2 calls. */
  id: string;
  bench: string;
  campaign: string;
  cell: string;
  cell_sha: string;
  agent: ResolvedCell['agent'];
  harness: string;
  model: string;
  family: string;
  task: string;
  item: string;
  try: number;
  /** 1 for the first execution of this try; more after an interrupted execution was voided. */
  execution: number;
  status: 'running' | 'done' | 'void';
  void_reason?: string;
  result?: Outcome;
  reward?: number | null;
  exception?: string;
  job_name: string;
  job_dir: string;
  trial_name?: string;
  pid?: number;
  started_at: number;
  deadline_at: number;
  finished_at?: number;
  seconds?: number;
  agent_seconds?: number;
  verifier_seconds?: number;
  cost_usd?: number;
  cost_usd_estimate?: number;
  cost_state: CostState;
  gateway_calls?: number;
  n_input_tokens?: number;
  n_output_tokens?: number;
  n_cache_tokens?: number;
  stablehand?: StablehandTurnRef;
  trajectories?: string[];
  harbor_exit?: number | null;
}

export function benchDir(id: string): string {
  return join(BENCH_WORK, id);
}

export function definitionPath(id: string): string {
  return join(benchDir(id), 'bench.json');
}

export function tasksSha(tasks: TaskInfo[]): string {
  return sha16(tasks.map((t) => [t.name, t.instruction_sha, t.verifier_sha, t.environment_sha].join('|')).sort().join('\n'));
}

export function loadDefinition(id: string): BenchDefinition {
  const p = definitionPath(id);
  if (!existsSync(p)) throw new Error(`no bench ${id} at ${p}; create it with \`cli.ts init\``);
  return readJson<BenchDefinition>(p);
}

export function saveDefinition(def: BenchDefinition): void {
  writeJson(definitionPath(def.id), def);
}

export function bestCost(a: BenchAttempt): number {
  return a.cost_usd ?? a.cost_usd_estimate ?? 0;
}

export class AttemptStore {
  readonly root: string;
  readonly benchId: string;

  constructor(benchId: string) {
    this.benchId = benchId;
    this.root = join(benchDir(benchId), 'attempts');
    ensureDir(this.root);
  }

  dirFor(cell: string, task: string): string {
    return join(this.root, cellSlug(cell), task);
  }

  pathFor(cell: string, task: string, tryN: number): string {
    return join(this.dirFor(cell, task), `t${String(tryN).padStart(2, '0')}.json`);
  }

  get(cell: string, task: string, tryN: number): BenchAttempt | undefined {
    const p = this.pathFor(cell, task, tryN);
    return existsSync(p) ? readJson<BenchAttempt>(p) : undefined;
  }

  save(a: BenchAttempt): void {
    writeJson(this.pathFor(a.cell, a.task, a.try), a);
  }

  /** Move an interrupted execution aside; its spend stays in the ledger, and the try runs again. */
  voidAttempt(a: BenchAttempt, reason: string): BenchAttempt {
    const done: BenchAttempt = { ...a, status: 'void', void_reason: reason, finished_at: a.finished_at ?? Date.now() };
    const dir = this.dirFor(a.cell, a.task);
    const base = `t${String(a.try).padStart(2, '0')}`;
    writeJson(join(dir, `${base}.void-${a.execution}.json`), done);
    rmSync(this.pathFor(a.cell, a.task, a.try), { force: true });
    return done;
  }

  /** Re-save a voided execution (its cost settled later). */
  saveVoid(a: BenchAttempt): void {
    writeJson(join(this.dirFor(a.cell, a.task), `t${String(a.try).padStart(2, '0')}.void-${a.execution}.json`), a);
  }

  /** Every record: counting attempts and voided executions. */
  all(): BenchAttempt[] {
    const out: BenchAttempt[] = [];
    if (!existsSync(this.root)) return out;
    for (const cell of readdirSync(this.root)) {
      for (const task of readdirSync(join(this.root, cell))) {
        for (const f of readdirSync(join(this.root, cell, task))) {
          if (f.endsWith('.json')) out.push(readJson<BenchAttempt>(join(this.root, cell, task, f)));
        }
      }
    }
    return out.sort((a, b) => a.started_at - b.started_at);
  }

  /** The attempts that count: one per (cell, task, try), finished. */
  counted(cell?: string): BenchAttempt[] {
    return this.all().filter((a) => a.status === 'done' && (!cell || a.cell === cell));
  }
}
