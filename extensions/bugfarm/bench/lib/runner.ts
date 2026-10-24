// The benchmark runner: k tries per task per cell, a bounded number of trials at once, a budget
// gate in front of every launch, and crash-safe records.
//
// Resuming after a crash or kill:
// - a Harbor process the previous runner started and that is still alive is adopted: the runner
//   waits for it and reads its result, so the attempt is neither lost nor run twice;
// - a trial that finished while no runner was watching is read from Harbor's result;
// - a trial our own crash cut short is voided (its spend stays in the ledger) and the try runs
//   again, because the agent never got a fair attempt;
// - a record whose Harbor process never started is simply launched.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cleanupAttempt } from '../../pipeline/calibrate-harbor.ts';
import { isDir, log } from '../../pipeline/lib/util.ts';
import { attemptRow, cellRow } from './board.ts';
import type { BoardSink } from './board.ts';
import { cellSlug } from './config.ts';
import type { ResolvedCell } from './config.ts';
import { enforceDeadline, finalize, isOurHarbor, launch, processDeadlineMs, trialFinished, trialNames, waitForPid } from './harbor.ts';
import type { LaunchEnv } from './harbor.ts';
import { api, searchTurns, settle } from './spend.ts';
import type { PricingContext } from './spend.ts';
import { benchDir, bestCost } from './store.ts';
import type { AttemptStore, BenchAttempt, BenchDefinition } from './store.ts';

/** How many times one try may run when the provider or the environment, not the agent, fails it. */
export const MAX_EXECUTIONS = 3;

const PROVIDER_FAILURE = /\b429\b|rate.?limit|throttl|RateLimitError|\b50[234]\b|overloaded|ServiceUnavailable|InternalServerError|ECONNRESET|ECONNREFUSED|model_gateway_unavailable|service "main" is not running|DockerException|docker compose .* failed/i;

/**
 * Why a finished try should not count against its agent, or null when it should. A try with no
 * verifier reward never got graded; a try whose agent stopped on a provider error (a rate limit, a
 * 5xx) or a broken container never got a fair run. A per-try spend cap or an agent timeout is the
 * agent's own outcome and counts.
 */
export function providerFailure(a: BenchAttempt): string | null {
  if (a.status !== 'done' || a.result === 'pass') return null;
  if (a.result === 'error') return `provider or environment: no verifier reward${a.exception ? ` (${a.exception.slice(0, 160)})` : ''}`;
  if (a.exception && PROVIDER_FAILURE.test(a.exception) && !/spend cap|AgentTimeoutError/i.test(a.exception)) return `provider: ${a.exception.slice(0, 200)}`;
  return null;
}

export interface RunOptions {
  concurrency: number;
  /** The gate's limit: launches stop before the bench's spend (settled plus reserved) would pass it. */
  budgetUsd: number;
  reserveFactor: number;
  cells?: string[];
  /** Run tries 1..maxTries only (default: the bench's k). */
  maxTries?: number;
  /** Print the plan and exit. */
  plan?: boolean;
}

export interface RunSummary {
  launched: number;
  adopted: number;
  recovered: number;
  voided: number;
  finished: number;
  skipped_for_budget: number;
  stopped: 'done' | 'budget' | 'signal';
  spend_usd: number;
}

class CostModel {
  private readonly seen = new Map<string, number[]>();

  observe(cell: string, usd: number): void {
    const list = this.seen.get(cell) ?? [];
    list.push(usd);
    this.seen.set(cell, list);
  }

  estimate(cell: ResolvedCell): number {
    const seen = this.seen.get(cell.id) ?? [];
    if (!seen.length) return cell.est_attempt_usd;
    const mean = seen.reduce((a, b) => a + b, 0) / seen.length;
    return seen.length === 1 ? Math.max(cell.est_attempt_usd, mean) : mean;
  }
}

interface Slot {
  a: BenchAttempt;
  cell: ResolvedCell;
  reserved: number;
  done: Promise<BenchAttempt>;
}

function jobName(cell: ResolvedCell, task: string, tryN: number, execution: number): string {
  return `${cellSlug(cell.id)}__${task}__t${String(tryN).padStart(2, '0')}__e${execution}`;
}

export function newAttempt(def: BenchDefinition, cell: ResolvedCell, taskName: string, tryN: number, execution: number): BenchAttempt {
  const task = def.tasks.find((t) => t.name === taskName);
  if (!task) throw new Error(`task ${taskName} is not in bench ${def.id}`);
  const name = jobName(cell, taskName, tryN, execution);
  return {
    id: `${def.id}.${name}.${randomBytes(3).toString('hex')}`,
    bench: def.id,
    campaign: def.campaign,
    cell: cell.id,
    cell_sha: cell.sha,
    agent: cell.agent,
    harness: cell.harness as string,
    model: cell.model,
    family: cell.family,
    task: taskName,
    item: task.item,
    try: tryN,
    execution,
    status: 'running',
    job_name: name,
    job_dir: join(benchDir(def.id), 'jobs', name),
    started_at: Date.now(),
    deadline_at: Date.now() + processDeadlineMs(cell),
    cost_state: 'pending',
  };
}

/**
 * Read a finished trial. If reading it fails (a malformed result file), record the try as an error
 * with the reason rather than crash the run and leave the record for the next run to trip on.
 */
async function finalizeSafely(a: BenchAttempt, trajDir: string, exit: number | null): Promise<BenchAttempt> {
  try {
    return await finalize(a, trajDir, exit);
  } catch (e) {
    log('bench', `${a.job_name}: could not read the trial (${String(e)}); recording an error`);
    return { ...a, status: 'done', result: 'error', reward: null, exception: `could not read the trial: ${String(e).slice(0, 300)}`, finished_at: Date.now(), seconds: Math.round((Date.now() - a.started_at) / 100) / 10, pid: undefined };
  }
}

async function cancelStablehandTurn(pricing: PricingContext, def: BenchDefinition, a: BenchAttempt): Promise<void> {
  if (!pricing.stablehand || a.agent !== 'stablehand') return;
  const trials = trialNames(a.job_dir);
  for (const trial of trials) {
    const turns = await searchTurns(pricing.stablehand, { campaign: def.campaign, bench_cell: a.cell, trial }).catch(() => []);
    for (const t of turns.filter((x) => x.status === 'QUEUED' || x.status === 'RUNNING')) {
      await api(pricing.stablehand, 'POST', `/api/agents/${t.agentId}/turns/${t.id}/cancel`, {}).catch((e: unknown) => log('bench', `could not cancel turn ${t.id}: ${String(e)}`));
      log('bench', `${a.job_name}: cancelled its orphaned Stablehand turn ${t.id}`);
    }
    if (!a.trial_name) a.trial_name = trial;
  }
}

export async function runBench(def: BenchDefinition, store: AttemptStore, env: LaunchEnv, pricing: PricingContext, board: BoardSink, opts: RunOptions): Promise<RunSummary> {
  const cells = def.cells.filter((c) => !opts.cells || opts.cells.includes(c.id));
  if (!cells.length) throw new Error('no cells to run');
  const k = Math.min(def.k, opts.maxTries ?? def.k);
  const jobsDir = join(benchDir(def.id), 'jobs');
  const trajDir = join(benchDir(def.id), 'trajectories');
  const taskDir = (name: string) => join(benchDir(def.id), 'tasks', name);
  const summary: RunSummary = { launched: 0, adopted: 0, recovered: 0, voided: 0, finished: 0, skipped_for_budget: 0, stopped: 'done', spend_usd: 0 };
  const costs = new CostModel();
  for (const a of store.all()) if (a.status === 'done') costs.observe(a.cell, bestCost(a));

  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) {
      log('bench', `${sig} again: exiting now; running trials continue and the next run adopts them`);
      process.exit(130);
    }
    stopping = true;
    log('bench', `${sig}: no new trials; waiting for the running ones (send it again to leave them running and exit)`);
  };
  const sigint = () => onSignal('SIGINT');
  const sigterm = () => onSignal('SIGTERM');
  if (!opts.plan) {
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
  }

  const inflight = new Map<string, Slot>();
  const queue: Array<{ cell: ResolvedCell; task: string; tryN: number }> = [];
  const slotKey = (cell: string, task: string, tryN: number) => `${cell}|${task}|${tryN}`;
  const publishCell = async (cell: ResolvedCell) => {
    const all = store.all();
    const running = [...inflight.values()].filter((s) => s.cell.id === cell.id).length;
    await board.write([cellRow(def, cell, all, running)]);
  };
  const spent = () => store.all().filter((a) => a.status !== 'running').reduce((s, a) => s + bestCost(a), 0);
  const reservedTotal = () => [...inflight.values()].reduce((s, x) => s + x.reserved, 0);

  const complete = async (slot: Slot, finished: BenchAttempt) => {
    const why = providerFailure(finished);
    if (why && finished.execution < MAX_EXECUTIONS) {
      store.save(finished);
      store.voidAttempt(finished, why);
      summary.voided++;
      log('bench', `${finished.job_name}: ${why.slice(0, 160)}; voided, the try runs again`);
      queue.unshift({ cell: slot.cell, task: finished.task, tryN: finished.try });
      await publishCell(slot.cell);
      return;
    }
    store.save(finished);
    costs.observe(finished.cell, bestCost(finished));
    summary.finished++;
    log('bench', `${finished.job_name}: ${finished.result}${finished.exception ? ` (${finished.exception.slice(0, 140)})` : ''} in ${Math.round(finished.agent_seconds ?? finished.seconds ?? 0)}s, $${bestCost(finished).toFixed(4)} [${finished.cost_state}]`);
    await board.write([attemptRow(finished)]);
    await publishCell(slot.cell);
  };

  // --- Recover what a previous runner left -----------------------------------------------------
  for (const a of store.all().filter((x) => x.status === 'running')) {
    const cell = def.cells.find((c) => c.id === a.cell);
    if (!cell) continue;
    if (isOurHarbor(a.pid, a.job_name)) {
      log('bench', `${a.job_name}: adopting the running Harbor process ${a.pid}`);
      summary.adopted++;
      const done = (async () => {
        const how = await waitForPid(a.pid as number, a.job_name, a.deadline_at);
        return finalizeSafely(a, trajDir, how === 'killed' ? null : 0);
      })();
      inflight.set(slotKey(a.cell, a.task, a.try), { a, cell, reserved: costs.estimate(cell), done });
      continue;
    }
    if (trialFinished(a.job_dir)) {
      const fin = await finalizeSafely(a, trajDir, null);
      store.save(fin);
      costs.observe(fin.cell, bestCost(fin));
      summary.recovered++;
      log('bench', `${a.job_name}: finished while no runner watched; recorded ${fin.result}`);
      await board.write([attemptRow(fin)]);
      continue;
    }
    if (!isDir(a.job_dir) && !existsSync(join(jobsDir, `${a.job_name}.config.json`))) {
      // Written, but Harbor never started: nothing ran, nothing was spent.
      rmSync(store.pathFor(a.cell, a.task, a.try), { force: true });
      log('bench', `${a.job_name}: never started; it will run now`);
      continue;
    }
    await cancelStablehandTurn(pricing, def, a);
    await cleanupAttempt({ jobName: a.job_name }, trialNames(a.job_dir)).catch(() => undefined);
    store.voidAttempt(a, 'interrupted: the runner stopped during this trial');
    summary.voided++;
    log('bench', `${a.job_name}: interrupted by the runner, voided (its spend stays in the ledger); the try runs again`);
  }
  for (const cell of cells) await publishCell(cell);

  // --- The queue: try by try, task by task, every cell, so a budget stop leaves cells even -------
  for (let tryN = 1; tryN <= k; tryN++) {
    for (const task of def.tasks) {
      for (const cell of cells) {
        if (inflight.has(slotKey(cell.id, task.name, tryN))) continue;
        const rec = store.get(cell.id, task.name, tryN);
        const why = rec ? providerFailure(rec) : null;
        if (rec && why && rec.execution < MAX_EXECUTIONS && !opts.plan) {
          store.voidAttempt(rec, why);
          summary.voided++;
          log('bench', `${rec.job_name}: ${why.slice(0, 120)}; voided, the try runs again`);
        } else if (rec?.status === 'done') continue;
        queue.push({ cell, task: task.name, tryN });
      }
    }
  }
  const remainingCost = queue.reduce((s, q) => s + costs.estimate(q.cell), 0);
  log('bench', `${def.id}: ${queue.length} tries to run over ${cells.length} cells (k=${k}, ${def.tasks.length} tasks), about $${remainingCost.toFixed(2)}; spent so far $${spent().toFixed(2)} of a $${opts.budgetUsd.toFixed(2)} gate`);
  if (opts.plan) {
    for (const q of queue) console.log(`${q.cell.id}\t${q.task}\ttry ${q.tryN}\t~$${costs.estimate(q.cell).toFixed(3)}`);
    return summary;
  }

  let lastSettle = 0;
  let rechecked = false;
  for (;;) {
    // Settle costs every minute so the gate runs on the gateway's numbers.
    if (Date.now() - lastSettle > 60_000) {
      lastSettle = Date.now();
      const changed = await settle(store, def, pricing).catch((e: unknown) => {
        log('spend', `settle failed: ${String(e)}`);
        return [] as BenchAttempt[];
      });
      if (changed.length) {
        await board.write(changed.filter((a) => a.status === 'done').map(attemptRow));
        for (const cell of new Set(changed.map((a) => a.cell))) {
          const c = cells.find((x) => x.id === cell);
          if (c) await publishCell(c);
        }
      }
    }
    while (!stopping && inflight.size < opts.concurrency && queue.length) {
      const busy = (cell: ResolvedCell) => [...inflight.values()].filter((s) => s.cell.id === cell.id).length;
      const idx = queue.findIndex((q) => busy(q.cell) < (q.cell.max_concurrent ?? Infinity) && spent() + reservedTotal() + costs.estimate(q.cell) * (1 + opts.reserveFactor) <= opts.budgetUsd);
      if (idx < 0) break;
      const [q] = queue.splice(idx, 1);
      const prior = store.all().filter((a) => a.cell === q.cell.id && a.task === q.task && a.try === q.tryN);
      const execution = prior.length ? Math.max(...prior.map((a) => a.execution)) + 1 : 1;
      const a = newAttempt(def, q.cell, q.task, q.tryN, execution);
      store.save(a);
      let launched;
      try {
        launched = launch(a, q.cell, def, taskDir(q.task), jobsDir, env);
      } catch (e) {
        rmSync(store.pathFor(a.cell, a.task, a.try), { force: true });
        throw e;
      }
      a.pid = launched.pid;
      store.save(a);
      summary.launched++;
      const stop = enforceDeadline(launched, a.job_name, a.deadline_at);
      const reserved = costs.estimate(q.cell) * (1 + opts.reserveFactor);
      const done = launched.exited.then(async (code) => {
        stop();
        return finalizeSafely(a, trajDir, code);
      });
      inflight.set(slotKey(a.cell, a.task, a.try), { a, cell: q.cell, reserved, done });
      log('bench', `${a.job_name}: started (pid ${launched.pid}; ${inflight.size} running, ${queue.length} queued)`);
      await publishCell(q.cell);
    }
    if (!inflight.size) {
      if (queue.length && !stopping && !rechecked) {
        // Settled costs are often below the estimates the gate held back: settle, then look once more.
        rechecked = true;
        lastSettle = 0;
        continue;
      }
      if (queue.length && !stopping) {
        summary.skipped_for_budget = queue.length;
        summary.stopped = 'budget';
        log('bench', `budget gate: ${queue.length} tries do not fit in the $${opts.budgetUsd.toFixed(2)} gate (spent $${spent().toFixed(2)}); stopping`);
      } else if (stopping) summary.stopped = 'signal';
      break;
    }
    const [key, fin] = await Promise.race([...inflight.entries()].map(async ([key, s]) => [key, await s.done] as const));
    const slot = inflight.get(key) as Slot;
    inflight.delete(key);
    await complete(slot, fin);
    rechecked = false;
  }

  // Price what just finished, then publish the final rows.
  const changed = await settle(store, def, pricing).catch(() => [] as BenchAttempt[]);
  if (changed.length) await board.write(changed.filter((a) => a.status === 'done').map(attemptRow));
  for (const cell of cells) await publishCell(cell);
  summary.spend_usd = Math.round(spent() * 1e6) / 1e6;
  process.off('SIGINT', sigint);
  process.off('SIGTERM', sigterm);
  return summary;
}
