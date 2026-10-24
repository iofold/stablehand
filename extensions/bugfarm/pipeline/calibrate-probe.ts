// Model probes: one task, several models, a few terminus-2 attempts each, no ladder. They answer
// pricing questions before a panel is frozen, for example what a plain alias costs against its
// `-autocache` sibling on the same task. Each attempt is priced from the gateway's spend log, with
// the tokens it logged: prompt (cache reads and writes included), cache reads, cache writes and
// output. Probe attempts are never calibration attempts: they live under
// `.work/calibration/probes/<id>/` and pool with nothing.
import { join } from 'node:path';
import { log, mapLimit, writeJson } from './lib/util.ts';
import { runAttempt } from './calibrate-harbor.ts';
import type { AttemptOutcome } from './calibrate-harbor.ts';
import type { AttemptSpend, CallTokens, SpendLog } from './calibrate-gateway.ts';
import { CALIBRATION_DIR, fileSafe, knownModel } from './calibrate-panel.ts';
import type { Panel } from './calibrate-panel.ts';

export interface ProbeAttempt {
  attempt_id: string;
  model: string;
  try: number;
  outcome: Omit<AttemptOutcome, 'trajectories' | 'trajectories_v17'>;
  gateway?: AttemptSpend;
}

export interface ProbeModelRow {
  model: string;
  attempts: number;
  passes: number;
  errors: number;
  calls: number;
  cost_usd: number;
  per_attempt_usd: number;
  per_call_usd: number;
  tokens: CallTokens;
  /** Share of prompt tokens served from the cache. */
  cache_read_share: number;
  /** What the same calls would cost with no cache: every prompt token at the input price. */
  uncached_usd: number;
  /** 1 - cost / uncached. */
  saved_share: number;
  minutes_per_attempt: number;
}

export interface ProbeOptions {
  gatewayUrl: string;
  gatewayKey: string;
  spendLog?: SpendLog;
  probeId: string;
  concurrency: number;
  /** How long to wait for the spend log to price every call (default 4 minutes). */
  settleTimeoutMs?: number;
}

export function probeDir(probeId: string): string {
  return join(CALIBRATION_DIR, 'probes', probeId);
}

const round = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

/** Per-model totals for a probe's attempts. Exported for tests. */
export function probeRows(attempts: ProbeAttempt[]): ProbeModelRow[] {
  const models = [...new Set(attempts.map((a) => a.model))];
  return models.map((model) => {
    const mine = attempts.filter((a) => a.model === model);
    const tokens: CallTokens = { prompt: 0, completion: 0, cache_read: 0, cache_write: 0 };
    let cost = 0;
    let calls = 0;
    let secs = 0;
    for (const a of mine) {
      cost += a.gateway?.cost_usd ?? a.outcome.cost_usd_estimate ?? 0;
      calls += a.gateway?.calls ?? 0;
      secs += a.outcome.seconds;
      for (const k of ['prompt', 'completion', 'cache_read', 'cache_write'] as const) tokens[k] += a.gateway?.tokens[k] ?? 0;
    }
    const price = knownModel(model)?.pricing;
    const uncached = price ? tokens.prompt * price.input + tokens.completion * price.output : 0;
    return {
      model,
      attempts: mine.length,
      passes: mine.filter((a) => a.outcome.result === 'pass').length,
      errors: mine.filter((a) => a.outcome.result === 'error').length,
      calls,
      cost_usd: round(cost),
      per_attempt_usd: round(cost / Math.max(1, mine.length)),
      per_call_usd: round(cost / Math.max(1, calls)),
      tokens,
      cache_read_share: round(tokens.prompt ? tokens.cache_read / tokens.prompt : 0, 4),
      uncached_usd: round(uncached),
      saved_share: round(uncached > 0 ? 1 - cost / uncached : 0, 4),
      minutes_per_attempt: round(secs / Math.max(1, mine.length) / 60, 1),
    };
  });
}

export function probeTable(rows: ProbeModelRow[]): string {
  const lines = [
    '| model | attempts | passes | calls | prompt tokens | cache reads | cache writes | output tokens | cost | $/attempt | $/call | without cache | saved | min/attempt |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.model} | ${r.attempts} | ${r.passes} | ${r.calls} | ${r.tokens.prompt} | ${r.tokens.cache_read} (${(r.cache_read_share * 100).toFixed(0)}%) | ${r.tokens.cache_write} | ${r.tokens.completion} | $${r.cost_usd.toFixed(3)} | $${r.per_attempt_usd.toFixed(3)} | $${r.per_call_usd.toFixed(4)} | $${r.uncached_usd.toFixed(3)} | ${(r.saved_share * 100).toFixed(0)}% | ${r.minutes_per_attempt} |`);
  }
  return lines.join('\n');
}

/** Run `tries` attempts per model on one task with the panel's solver settings, then price them. */
export async function probeModels(task: { dir: string; name: string }, panel: Panel, models: string[], tries: number, opts: ProbeOptions): Promise<{ attempts: ProbeAttempt[]; rows: ProbeModelRow[] }> {
  const dir = probeDir(opts.probeId);
  const specs = models.flatMap((model) => Array.from({ length: tries }, (_, i) => ({ model, tryNo: i + 1 })));
  for (const s of specs) if (!knownModel(s.model)) throw new Error(`no prices for ${s.model}; add it to a panel first`);
  log('probe', `${opts.probeId}: ${specs.length} attempts on ${task.name} (${models.join(', ')}), ${opts.concurrency} at a time`);
  const attempts = await mapLimit(specs, opts.concurrency, async ({ model, tryNo }): Promise<ProbeAttempt> => {
    const attemptId = `${opts.probeId}:${task.name}:${model}:${tryNo}`;
    const slug = `${fileSafe(model)}-t${String(tryNo).padStart(2, '0')}`;
    const out = await runAttempt(
      {
        attemptId,
        taskDir: task.dir,
        jobsDir: join(dir, 'jobs'),
        jobName: `${task.name}__${slug}`,
        model: knownModel(model) as NonNullable<ReturnType<typeof knownModel>>,
        agentKwargs: panel.agent_kwargs,
        agentTimeoutSec: panel.agent_timeout_sec,
        gatewayUrl: opts.gatewayUrl,
        gatewayKey: opts.gatewayKey,
        spendMetadata: { bugfarm_probe: opts.probeId },
        processTimeoutMs: (panel.agent_timeout_sec + 3600) * 1000,
        runId: opts.probeId,
      },
      { trajectoryDir: join(dir, 'trajectories'), attemptSlug: slug },
    );
    log('probe', `${model} try ${tryNo}: ${out.result} in ${out.seconds}s, ${out.llm_calls ?? '?'} calls, est $${(out.cost_usd_estimate ?? 0).toFixed(4)}`);
    const { trajectories: _t, trajectories_v17: _v, ...outcome } = out;
    return { attempt_id: attemptId, model, try: tryNo, outcome };
  });

  // Price every attempt from the spend log once it has all of the attempt's calls.
  if (opts.spendLog) {
    const deadline = Date.now() + (opts.settleTimeoutMs ?? 240_000);
    for (;;) {
      const snap = await opts.spendLog.snapshot(0);
      let complete = true;
      for (const a of attempts) {
        a.gateway = snap.by_attempt.get(a.attempt_id);
        const expected = a.outcome.llm_calls ?? 1;
        if (!a.gateway || a.gateway.calls < expected) complete = false;
      }
      if (complete || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  const rows = probeRows(attempts);
  writeJson(join(dir, 'probe.json'), { probe: opts.probeId, task: task.name, models, tries, panel: panel.id, at: new Date().toISOString(), rows, attempts });
  return { attempts, rows };
}
