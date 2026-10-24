// Pricing and reconciliation for a bench campaign.
//
// Three views of the same money, which must agree:
// 1. The bench ledger: one cost per attempt (and per voided execution).
//    - terminus-2 attempts are priced from the gateway's spend log, where every call carries the
//      attempt id (`bugfarm_attempt`) and was made with the campaign key;
//    - StablehandAgent attempts are priced from their Stablehand turn, which Stablehand prices from
//      the same gateway (per-session keys, correlated by `stablehand_turn_correlation`).
// 2. The gateway's own spend log, read independently: the campaign key's rows, plus the session-key
//    rows whose correlation id belongs to one of this bench's turns.
// 3. Stablehand's campaign budget: the spend of every run tagged `{campaign}` plus the campaign
//    key's ledger, which is what the cap is enforced on.
import { createHash } from 'node:crypto';
import { SpendLog, getCampaignKey, readCampaignKey } from '../../pipeline/calibrate-gateway.ts';
import type { CampaignKeyFile } from '../../pipeline/calibrate-gateway.ts';
import { log } from '../../pipeline/lib/util.ts';
import { round } from './stats.ts';
import { bestCost } from './store.ts';
import type { AttemptStore, BenchAttempt, BenchDefinition } from './store.ts';

export interface Api {
  url: string;
  token: string;
}

export async function api<T>(a: Api, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${a.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${a.token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.replace(/\?.*$/, '')} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface TurnUsage {
  totalTokens?: number;
  cost?: { totalUsd?: number | null; knownUsd?: number | null; coverage?: string } | null;
}

export interface TurnRow {
  id: string;
  agentId: string;
  status: string;
  tags?: Record<string, string>;
  usage?: TurnUsage | null;
  gatewayMode?: string | null;
  gatewayCorrelationId?: string | null;
  queuedAt?: number;
  completedAt?: number | null;
}

export function turnCost(t: { usage?: TurnUsage | null }): { usd: number | null; coverage: string | null } {
  const c = t.usage?.cost;
  if (!c) return { usd: null, coverage: null };
  const usd = typeof c.totalUsd === 'number' ? c.totalUsd : typeof c.knownUsd === 'number' ? c.knownUsd : null;
  return { usd, coverage: c.coverage ?? null };
}

export async function searchTurns(a: Api, tags: Record<string, string>): Promise<TurnRow[]> {
  const out: TurnRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page++) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(tags)) q.append('tag', `${k}:${v}`);
    q.set('limit', '200');
    if (cursor) q.set('cursor', cursor);
    const r = await api<{ turns: TurnRow[]; nextCursor?: string }>(a, 'GET', `/api/turns?${q}`);
    out.push(...r.turns);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export async function getTurn(a: Api, turnId: string): Promise<TurnRow> {
  return (await api<{ turn: TurnRow }>(a, 'GET', `/api/turns/${encodeURIComponent(turnId)}`)).turn;
}

// ---------------------------------------------------------------------------------------------
// Session-key spend rows, grouped by turn correlation

interface SpendRowRaw {
  request_id: string;
  spend: number;
  startTime: string;
  metadata?: { spend_logs_metadata?: Record<string, unknown> | null } | null;
}

export interface CorrelatedSpend {
  rows: number;
  usd: number;
  byCorrelation: Map<string, { calls: number; usd: number }>;
}

/** Spend-log rows of keys Stablehand issued for turns, over a date window, grouped by correlation id. */
export async function sessionSpend(gatewayUrl: string, meteringKey: string, sinceMs: number, filters: Array<{ key_alias: string } | { api_key: string }>): Promise<CorrelatedSpend> {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const out: CorrelatedSpend = { rows: 0, usd: 0, byCorrelation: new Map() };
  for (const filter of filters) {
    let totalPages = 1;
    for (let page = 1; page <= totalPages && page <= 2000; page++) {
      const q = new URLSearchParams({ start_date: day(sinceMs - 86_400_000), end_date: day(Date.now() + 2 * 86_400_000), page: String(page), page_size: '100', sort_by: 'startTime', sort_order: 'asc', ...filter });
      const res = await fetch(`${gatewayUrl}/spend/logs/v2?${q}`, { headers: { authorization: `Bearer ${meteringKey}` }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`gateway spend log HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { data: SpendRowRaw[]; total_pages: number };
      totalPages = body.total_pages;
      for (const row of body.data) {
        if (seen.has(row.request_id)) continue;
        seen.add(row.request_id);
        if (Date.parse(row.startTime) < sinceMs - 60_000) continue;
        const corr = row.metadata?.spend_logs_metadata?.stablehand_turn_correlation;
        if (typeof corr !== 'string') continue;
        out.rows++;
        const usd = Number(row.spend) || 0;
        out.usd += usd;
        const cur = out.byCorrelation.get(corr) ?? { calls: 0, usd: 0 };
        cur.calls++;
        cur.usd += usd;
        out.byCorrelation.set(corr, cur);
      }
    }
  }
  return out;
}

export function liteLLMKeyHash(key: string): string {
  return key.startsWith('sk-') ? createHash('sha256').update(key).digest('hex') : key;
}

// ---------------------------------------------------------------------------------------------
// Settling attempt costs

export interface PricingContext {
  stablehand?: Api;
  gatewayUrl: string;
  meteringKey?: string;
  campaignKey?: CampaignKeyFile;
  spendLog?: SpendLog;
}

export function pricingContext(opts: { stablehand?: Api; gatewayUrl: string; meteringKey?: string; campaignKeyFile?: string }): PricingContext {
  let key: CampaignKeyFile | undefined;
  try {
    key = opts.campaignKeyFile ? readCampaignKey(opts.campaignKeyFile) : undefined;
  } catch {
    key = undefined;
  }
  return {
    stablehand: opts.stablehand,
    gatewayUrl: opts.gatewayUrl,
    meteringKey: opts.meteringKey,
    campaignKey: key,
    spendLog: key && opts.meteringKey ? new SpendLog({ gatewayUrl: opts.gatewayUrl, meteringKey: opts.meteringKey, keyAlias: key.key_alias, sinceMs: key.created_at || Date.now() - 30 * 86_400_000 }) : undefined,
  };
}

/** Find the Stablehand turn of an attempt that never collected it (a voided or cancelled trial). */
async function findTurn(ctx: PricingContext, def: BenchDefinition, a: BenchAttempt): Promise<TurnRow | undefined> {
  if (!ctx.stablehand) return undefined;
  if (a.stablehand?.turn_id) return getTurn(ctx.stablehand, a.stablehand.turn_id).catch(() => undefined);
  if (!a.trial_name) return undefined;
  const turns = await searchTurns(ctx.stablehand, { campaign: def.campaign, bench_cell: a.cell, trial: a.trial_name }).catch(() => []);
  return turns[0];
}

/**
 * Price every finished or voided attempt that is not settled yet. Returns the records it changed.
 * `final` also settles attempts the gateway never saw (they cost nothing) once they are old enough.
 */
export async function settle(store: AttemptStore, def: BenchDefinition, ctx: PricingContext, opts: { final?: boolean } = {}): Promise<BenchAttempt[]> {
  const changed: BenchAttempt[] = [];
  const open = store.all().filter((a) => a.status !== 'running' && a.cost_state !== 'gateway');
  if (!open.length) return changed;
  const snap = ctx.spendLog && open.some((a) => a.agent === 'terminus-2') ? await ctx.spendLog.snapshot(10_000).catch((e: unknown) => {
    log('spend', `spend log unavailable: ${String(e)}`);
    return undefined;
  }) : undefined;
  for (const a of open) {
    const before = `${a.cost_usd}:${a.cost_state}:${a.gateway_calls}`;
    if (a.agent === 'terminus-2') {
      const s = snap?.by_attempt.get(a.id);
      const age = Date.now() - (a.finished_at ?? a.started_at);
      if (s && age > 30_000) {
        a.cost_usd = round(s.cost_usd, 6);
        a.gateway_calls = s.calls;
        a.cost_state = 'gateway';
      } else if (!s && snap && opts.final && age > 5 * 60_000) {
        a.cost_usd = 0;
        a.gateway_calls = 0;
        a.cost_state = 'gateway';
      }
    } else {
      const t = await findTurn(ctx, def, a);
      if (t) {
        const c = turnCost(t);
        a.stablehand = { ...(a.stablehand ?? {}), turn_id: t.id, agent_id: t.agentId, status: t.status, gateway_correlation_id: t.gatewayCorrelationId ?? a.stablehand?.gateway_correlation_id, cost_coverage: c.coverage ?? undefined };
        if (c.usd !== null) a.cost_usd = round(c.usd, 6);
        // Stablehand's turn cost is the gateway's bill for that turn's session key.
        if (c.coverage === 'complete' && ['COMPLETED', 'ERROR', 'CANCELLED'].includes(t.status)) a.cost_state = 'gateway';
        else if (c.usd !== null) a.cost_state = 'turn';
      } else if (opts.final && Date.now() - (a.finished_at ?? a.started_at) > 5 * 60_000 && !a.stablehand?.turn_id) {
        // No turn ever started for this trial (the relay or agent creation failed first).
        a.cost_usd = 0;
        a.cost_state = 'gateway';
      }
    }
    if (`${a.cost_usd}:${a.cost_state}:${a.gateway_calls}` !== before) {
      if (a.status === 'void') store.saveVoid(a);
      else store.save(a);
      changed.push(a);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Reconciliation

export interface Reconciliation {
  at: number;
  campaign: string;
  ledger: {
    attempts: number;
    measured_usd: number;
    voided_executions: number;
    voided_usd: number;
    total_usd: number;
    unsettled: number;
    by_cell: Record<string, { attempts: number; usd: number }>;
    by_task: Record<string, { attempts: number; usd: number }>;
  };
  gateway: {
    campaign_key: { id: string; alias: string; rows: number; usd: number; matched_usd: number; unattributed_usd: number } | null;
    sessions: { rows: number; usd: number; turns_matched: number; turns_without_rows: number } | null;
    total_usd: number | null;
  };
  stablehand: {
    budget_policy: { id: string; name: string; cap_usd: number | null; spend_usd: number } | null;
    campaign_key_spend_usd: number | null;
    bench_turns_usd: number | null;
    other_tagged_turns: { turns: number; usd: number } | null;
  };
  differences: {
    ledger_vs_gateway_usd: number | null;
    ledger_vs_budget_usd: number | null;
  };
}

export async function findBudgetPolicy(a: Api, campaign: string): Promise<{ id: string; name: string; doc: { selector?: Record<string, string>; limits?: { costUsd?: number } } } | undefined> {
  const r = await api<{ policies: Array<{ id: string; name: string; doc: { selector?: Record<string, string>; limits?: { costUsd?: number } } }> }>(a, 'GET', '/api/budgets');
  return r.policies.find((p) => JSON.stringify(p.doc?.selector ?? {}) === JSON.stringify({ campaign }));
}

export async function reconcile(store: AttemptStore, def: BenchDefinition, ctx: PricingContext, runtimeKey?: string): Promise<Reconciliation> {
  await settle(store, def, ctx, { final: true });
  const all = store.all();
  const done = all.filter((a) => a.status === 'done');
  const voided = all.filter((a) => a.status === 'void');
  const byCell: Record<string, { attempts: number; usd: number }> = {};
  const byTask: Record<string, { attempts: number; usd: number }> = {};
  for (const a of [...done, ...voided]) {
    const c = (byCell[a.cell] ??= { attempts: 0, usd: 0 });
    const t = (byTask[a.task] ??= { attempts: 0, usd: 0 });
    c.attempts++;
    t.attempts++;
    c.usd += bestCost(a);
    t.usd += bestCost(a);
  }
  for (const v of [...Object.values(byCell), ...Object.values(byTask)]) v.usd = round(v.usd, 6);
  const measured = done.reduce((s, a) => s + bestCost(a), 0);
  const voidUsd = voided.reduce((s, a) => s + bestCost(a), 0);
  const ledgerTotal = measured + voidUsd;

  // Gateway, read independently.
  let campaignKey: Reconciliation['gateway']['campaign_key'] = null;
  if (ctx.spendLog && ctx.campaignKey) {
    const snap = await ctx.spendLog.snapshot(0);
    const ids = new Set(all.filter((a) => a.agent === 'terminus-2').map((a) => a.id));
    let matched = 0;
    for (const [id, s] of snap.by_attempt) if (ids.has(id)) matched += s.cost_usd;
    campaignKey = { id: ctx.campaignKey.id, alias: ctx.campaignKey.key_alias, rows: snap.rows, usd: round(snap.total_usd, 6), matched_usd: round(matched, 6), unattributed_usd: round(snap.total_usd - matched, 6) };
  }
  let sessions: Reconciliation['gateway']['sessions'] = null;
  const shAttempts = all.filter((a) => a.agent === 'stablehand' && a.stablehand?.gateway_correlation_id);
  if (ctx.meteringKey && shAttempts.length) {
    const since = Math.min(...shAttempts.map((a) => a.started_at));
    const filters: Array<{ key_alias: string } | { api_key: string }> = [{ key_alias: 'stablehand-session-' }];
    if (runtimeKey) filters.push({ api_key: liteLLMKeyHash(runtimeKey) });
    const s = await sessionSpend(ctx.gatewayUrl, ctx.meteringKey, since, filters);
    let usd = 0;
    let rows = 0;
    let matchedTurns = 0;
    for (const a of shAttempts) {
      const m = s.byCorrelation.get(a.stablehand?.gateway_correlation_id as string);
      if (m) {
        usd += m.usd;
        rows += m.calls;
        matchedTurns++;
      }
    }
    sessions = { rows, usd: round(usd, 6), turns_matched: matchedTurns, turns_without_rows: shAttempts.length - matchedTurns };
  }
  const gatewayTotal = campaignKey || sessions ? round((campaignKey?.matched_usd ?? 0) + (sessions?.usd ?? 0), 6) : null;

  // Stablehand's budget view.
  let policy: Reconciliation['stablehand']['budget_policy'] = null;
  let keySpend: number | null = null;
  let benchTurnsUsd: number | null = null;
  let other: Reconciliation['stablehand']['other_tagged_turns'] = null;
  if (ctx.stablehand) {
    const p = await findBudgetPolicy(ctx.stablehand, def.campaign).catch(() => undefined);
    if (p) {
      const spend = await api<{ buckets: Array<{ spend: { costUsd?: number | null } }> }>(ctx.stablehand, 'GET', `/api/budgets/${p.id}/spend`);
      policy = { id: p.id, name: p.name, cap_usd: p.doc?.limits?.costUsd ?? null, spend_usd: round(spend.buckets.reduce((s, b) => s + (b.spend.costUsd ?? 0), 0), 6) };
    }
    if (ctx.campaignKey) keySpend = round((await getCampaignKey({ url: ctx.stablehand.url, token: ctx.stablehand.token }, ctx.campaignKey.id)).spend.costUsd, 6);
    const turns = await searchTurns(ctx.stablehand, { campaign: def.campaign });
    const bench = turns.filter((t) => t.tags?.bench_cell);
    benchTurnsUsd = round(bench.reduce((s, t) => s + (turnCost(t).usd ?? 0), 0), 6);
    const rest = turns.filter((t) => !t.tags?.bench_cell);
    other = { turns: rest.length, usd: round(rest.reduce((s, t) => s + (turnCost(t).usd ?? 0), 0), 6) };
  }
  return {
    at: Date.now(),
    campaign: def.campaign,
    ledger: {
      attempts: done.length,
      measured_usd: round(measured, 6),
      voided_executions: voided.length,
      voided_usd: round(voidUsd, 6),
      total_usd: round(ledgerTotal, 6),
      unsettled: [...done, ...voided].filter((a) => a.cost_state !== 'gateway').length,
      by_cell: byCell,
      by_task: byTask,
    },
    gateway: { campaign_key: campaignKey, sessions, total_usd: gatewayTotal },
    stablehand: { budget_policy: policy, campaign_key_spend_usd: keySpend, bench_turns_usd: benchTurnsUsd, other_tagged_turns: other },
    differences: {
      ledger_vs_gateway_usd: gatewayTotal === null ? null : round(ledgerTotal - gatewayTotal, 6),
      ledger_vs_budget_usd: policy ? round(policy.spend_usd - (other?.usd ?? 0) - ledgerTotal, 6) : null,
    },
  };
}
