// The Stablehand model gateway, as calibration uses it:
// - mint a campaign key (master token), so every solver call is billed to the campaign's budget;
// - check that each panel route answers before the panel is frozen;
// - read the gateway's spend log to price each attempt exactly, and the campaign's spend in
//   Stablehand to reconcile the two.
//
// Secrets are read from files or the environment and never logged. The key file holds the only
// copy of a campaign key (Stablehand keeps its hash), so it is written 0600.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir, log } from './lib/util.ts';

export interface CampaignKeyFile {
  id: string;
  key: string;
  key_alias: string;
  tags: Record<string, string>;
  models: string[];
  max_budget_usd: number | null;
  created_at: number;
}

export interface CampaignKeyPublic {
  id: string;
  name: string;
  tags: Record<string, string>;
  models: string[];
  keyAlias: string;
  maxBudgetUsd: number | null;
  status: string;
  spend: { costUsd: number; totalTokens: number; calls: number; unpricedCalls: number; lastSpendAt: number | null };
}

export interface StablehandAdmin {
  /** Stablehand API base, e.g. http://localhost:3002. */
  url: string;
  /** The master STABLEHAND_API_TOKEN; campaign keys are master-only. */
  token: string;
}

async function jsonFetch<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url.replace(/\?.*$/, '')} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

/** POST /api/model-gateway/campaign-keys, then write the key to `keyFile` (0600). The key is never printed. */
export async function mintCampaignKey(admin: StablehandAdmin, opts: { name: string; tags: Record<string, string>; models: string[]; maxBudgetUsd: number; keyFile: string }): Promise<CampaignKeyFile> {
  const created = await jsonFetch<CampaignKeyPublic & { key: string }>(`${admin.url.replace(/\/+$/, '')}/api/model-gateway/campaign-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: opts.name, tags: opts.tags, models: opts.models, maxBudgetUsd: opts.maxBudgetUsd }),
  });
  const file: CampaignKeyFile = {
    id: created.id,
    key: created.key,
    key_alias: created.keyAlias,
    tags: created.tags,
    models: created.models,
    max_budget_usd: created.maxBudgetUsd,
    created_at: Date.now(),
  };
  ensureDir(dirname(opts.keyFile));
  writeFileSync(opts.keyFile, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  chmodSync(opts.keyFile, 0o600);
  log('gateway', `minted campaign key ${file.id} (${JSON.stringify(file.tags)}, cap $${file.max_budget_usd ?? 'none'}) -> ${opts.keyFile}`);
  return file;
}

export function readCampaignKey(keyFile: string): CampaignKeyFile {
  const k = JSON.parse(readFileSync(keyFile, 'utf8')) as Partial<CampaignKeyFile> & { keyAlias?: string; maxBudgetUsd?: number };
  if (!k.id || !k.key) throw new Error(`${keyFile} is not a campaign key file`);
  return {
    id: k.id,
    key: k.key,
    key_alias: k.key_alias ?? k.keyAlias ?? `stablehand-campaign-${k.id}`,
    tags: k.tags ?? {},
    models: k.models ?? [],
    max_budget_usd: k.max_budget_usd ?? k.maxBudgetUsd ?? null,
    created_at: k.created_at ?? 0,
  };
}

export async function getCampaignKey(admin: StablehandAdmin, id: string): Promise<CampaignKeyPublic> {
  return jsonFetch<CampaignKeyPublic>(`${admin.url.replace(/\/+$/, '')}/api/model-gateway/campaign-keys/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
}

/** Chat-completions body for a model; some models refuse `max_tokens` and want `max_completion_tokens`. */
export function tokenLimitParam(model: string, limit: number, completionTokensModels: string[]): Record<string, number> {
  return completionTokensModels.includes(model) ? { max_completion_tokens: limit } : { max_tokens: limit };
}

export interface RouteCheck {
  model: string;
  ok: boolean;
  seconds: number;
  status?: number;
  detail?: string;
  cost_usd?: number;
  resolved_model?: string;
}

/** One tiny chat call per model: does the route answer, and with what price per call. */
export async function checkRoutes(gatewayUrl: string, key: string, models: string[], opts: { completionTokensModels?: string[]; tag?: string } = {}): Promise<RouteCheck[]> {
  const out: RouteCheck[] = [];
  for (const model of models) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'x-litellm-spend-logs-metadata': JSON.stringify({ bugfarm_route_check: opts.tag ?? 'route-check' }),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
          ...tokenLimitParam(model, 400, opts.completionTokensModels ?? []),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      const seconds = Math.round((Date.now() - t0) / 100) / 10;
      if (!res.ok) {
        out.push({ model, ok: false, seconds, status: res.status, detail: text.slice(0, 300) });
        continue;
      }
      const body = JSON.parse(text) as { model?: string; choices?: Array<{ message?: { content?: string | null } }> };
      const content = body.choices?.[0]?.message?.content ?? '';
      const cost = Number(res.headers.get('x-litellm-response-cost') ?? NaN);
      out.push({ model, ok: content.trim().length > 0, seconds, status: res.status, detail: content.slice(0, 40), cost_usd: Number.isFinite(cost) ? cost : undefined, resolved_model: body.model });
    } catch (e) {
      out.push({ model, ok: false, seconds: Math.round((Date.now() - t0) / 100) / 10, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

interface UsageObject {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null;
}

export interface SpendRow {
  request_id: string;
  spend: number;
  startTime: string;
  status?: string;
  model_group?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  metadata?: { spend_logs_metadata?: Record<string, unknown> | null; usage_object?: UsageObject | null } | null;
}

/** Tokens of one model call, as the gateway logged them. `prompt` includes cache reads and writes. */
export interface CallTokens {
  prompt: number;
  completion: number;
  cache_read: number;
  cache_write: number;
}

export function rowTokens(row: SpendRow): CallTokens {
  const u = row.metadata?.usage_object ?? {};
  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    prompt: n(u.prompt_tokens ?? row.prompt_tokens),
    completion: n(u.completion_tokens ?? row.completion_tokens),
    cache_read: n(u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens),
    cache_write: n(u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_write_tokens),
  };
}

export interface AttemptSpend {
  cost_usd: number;
  calls: number;
  failed_calls: number;
  last_start_ms: number;
  tokens: CallTokens;
}

export interface SpendSnapshot {
  at: number;
  rows: number;
  total_usd: number;
  by_attempt: Map<string, AttemptSpend>;
  /** Rows of the key that carry no attempt id (route checks, strays). */
  unattributed: { calls: number; cost_usd: number };
}

/**
 * Reads the gateway's spend log for one campaign key and groups it by the attempt id each call
 * carried in `x-litellm-spend-logs-metadata`. Uses LiteLLM's `/spend/logs/v2` with the metering
 * key (read-only spend access), filtered by the key's alias, like Stablehand's own reconciler.
 * The log is written in batches, so a fresh attempt's rows show up seconds to a minute late.
 */
export class SpendLog {
  private readonly gatewayUrl: string;
  private readonly meteringKey: string;
  private readonly keyAlias: string;
  private readonly sinceMs: number;
  private last: SpendSnapshot | undefined;
  private inflight: Promise<SpendSnapshot> | undefined;

  constructor(opts: { gatewayUrl: string; meteringKey: string; keyAlias: string; sinceMs: number }) {
    this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, '');
    this.meteringKey = opts.meteringKey;
    this.keyAlias = opts.keyAlias;
    this.sinceMs = opts.sinceMs;
  }

  /** A snapshot no older than `maxAgeMs`; concurrent callers share one fetch. */
  async snapshot(maxAgeMs = 15_000): Promise<SpendSnapshot> {
    if (this.last && Date.now() - this.last.at < maxAgeMs) return this.last;
    if (!this.inflight) {
      this.inflight = this.fetchAll().finally(() => {
        this.inflight = undefined;
      });
    }
    this.last = await this.inflight;
    return this.last;
  }

  private async fetchAll(): Promise<SpendSnapshot> {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const seen = new Set<string>();
    const snap: SpendSnapshot = { at: Date.now(), rows: 0, total_usd: 0, by_attempt: new Map(), unattributed: { calls: 0, cost_usd: 0 } };
    let totalPages = 1;
    for (let page = 1; page <= totalPages && page <= 200; page++) {
      const q = new URLSearchParams({
        start_date: day(this.sinceMs - 86_400_000),
        end_date: day(Date.now() + 2 * 86_400_000), // exclusive
        key_alias: this.keyAlias,
        page: String(page),
        page_size: '100', // LiteLLM rejects larger pages with 422
        sort_by: 'startTime',
        sort_order: 'asc',
      });
      const body = await jsonFetch<{ data: SpendRow[]; total_pages: number }>(`${this.gatewayUrl}/spend/logs/v2?${q}`, {
        headers: { authorization: `Bearer ${this.meteringKey}` },
      });
      totalPages = body.total_pages;
      for (const row of body.data) {
        if (seen.has(row.request_id)) continue;
        seen.add(row.request_id);
        snap.rows++;
        const spend = Number(row.spend) || 0;
        snap.total_usd += spend;
        const id = row.metadata?.spend_logs_metadata?.bugfarm_attempt;
        if (typeof id !== 'string') {
          snap.unattributed.calls++;
          snap.unattributed.cost_usd += spend;
          continue;
        }
        const cur = snap.by_attempt.get(id) ?? { cost_usd: 0, calls: 0, failed_calls: 0, last_start_ms: 0, tokens: { prompt: 0, completion: 0, cache_read: 0, cache_write: 0 } };
        cur.cost_usd += spend;
        cur.calls++;
        const t = rowTokens(row);
        cur.tokens.prompt += t.prompt;
        cur.tokens.completion += t.completion;
        cur.tokens.cache_read += t.cache_read;
        cur.tokens.cache_write += t.cache_write;
        if (row.status && row.status !== 'success') cur.failed_calls++;
        cur.last_start_ms = Math.max(cur.last_start_ms, Date.parse(row.startTime) || 0);
        snap.by_attempt.set(id, cur);
      }
    }
    return snap;
  }
}

/** Reads `KEY=value` lines from a dotenv file without exporting them anywhere. */
export function readDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
