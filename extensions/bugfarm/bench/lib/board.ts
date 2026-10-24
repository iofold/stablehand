// Benchmark rows for the Bugfarm board: one `cell` row per harness x model and one `attempt` row
// per measurement attempt (phase `measurement`, so receipts keep them apart from calibration).
import { BoardClient, NullBoard } from '../../pipeline/calibrate-board.ts';
import type { BoardRow, BoardSink } from '../../pipeline/calibrate-board.ts';
import { join } from 'node:path';
import { cellStats, seedOf } from './stats.ts';
import type { CellStats } from './stats.ts';
import { benchDir, bestCost } from './store.ts';
import type { BenchAttempt, BenchDefinition } from './store.ts';
import type { ResolvedCell } from './config.ts';

export type { BoardRow, BoardSink };

export function boardFor(benchId: string, url?: string, token?: string): BoardSink {
  return url && token ? new BoardClient({ url, token, outbox: join(benchDir(benchId), 'board-outbox.jsonl') }) : new NullBoard();
}

export function cellKey(def: BenchDefinition, cell: ResolvedCell): string {
  return `${def.id}:${cell.id}`;
}

export function attemptKey(a: BenchAttempt): string {
  return `${a.item}:bench.${a.bench}:${a.cell}:${a.try}`;
}

export function attemptRow(a: BenchAttempt): BoardRow {
  return {
    kind: 'attempt',
    key: attemptKey(a),
    payload: {
      item: a.item,
      harness: a.harness,
      model: a.model,
      family: a.family,
      try: a.try,
      result: a.result ?? 'error',
      cost_usd: Math.round(bestCost(a) * 1e6) / 1e6,
      seconds: a.agent_seconds ?? a.seconds ?? 0,
      phase: 'measurement',
      at: a.finished_at ?? a.started_at,
      bench: a.bench,
      cell: a.cell,
      task: a.task,
      trial: a.trial_name ?? null,
      reward: a.reward ?? null,
      exception: a.exception ?? null,
      cost_state: a.cost_state,
      turn_id: a.stablehand?.turn_id ?? null,
    },
  };
}

export function statsFor(def: BenchDefinition, cell: ResolvedCell, attempts: BenchAttempt[]): CellStats {
  return cellStats(
    attempts.filter((a) => a.cell === cell.id && a.status === 'done').map((a) => ({ task: a.task, result: a.result ?? 'error', cost_usd: bestCost(a), seconds: a.agent_seconds ?? a.seconds ?? null })),
    seedOf(`${def.id}|${cell.id}`),
  );
}

/** The cell's own notes plus what the numbers alone don't say. Progress is in `attempts` / `planned_attempts`. */
export function cellNotes(cell: ResolvedCell, s: CellStats): string[] {
  const notes = [...cell.notes];
  if (s.errors) notes.push(`${s.errors} ${s.errors === 1 ? 'try' : 'tries'} errored and count as unsolved.`);
  return notes;
}

export function cellRow(def: BenchDefinition, cell: ResolvedCell, s: CellStats, running = 0): BoardRow {
  const planned = def.tasks.length * def.k;
  return {
    kind: 'cell',
    key: cellKey(def, cell),
    mode: 'replace',
    payload: {
      harness: cell.harness,
      model: cell.model,
      family: cell.family,
      solved: s.solved,
      attempts: s.attempts,
      tasks: s.tasks,
      pass_at_1: s.pass_at_1 ?? 0,
      ...(s.ci_low !== null ? { ci_low: s.ci_low } : {}),
      ...(s.ci_high !== null ? { ci_high: s.ci_high } : {}),
      usd_per_solve: s.usd_per_solve,
      cost_usd: s.cost_usd,
      // Bench fields: which run, what it measured, and how to read it.
      bench: def.id,
      campaign: def.campaign,
      repo: def.repo,
      cell: cell.id,
      agent: cell.agent === 'stablehand' ? 'StablehandAgent' : 'terminus-2',
      runner: cell.harness_label,
      native_tools: cell.native_tools ?? null,
      phase: 'measurement',
      k: def.k,
      planned_attempts: planned,
      running,
      measured: s.attempts > 0,
      tasks_planned: def.tasks.length,
      tasks_solved: s.tasks_solved,
      errors: s.errors,
      median_seconds: s.median_seconds,
      usd_per_attempt: s.usd_per_attempt,
      notes: cellNotes(cell, s),
      task_set: { kind: def.task_set.kind, label: def.task_set.label, note: def.task_set.note ?? null },
      ci_method: 'bootstrap over tasks, 10,000 resamples, 95%',
      updated_at: Date.now(),
    },
  };
}
