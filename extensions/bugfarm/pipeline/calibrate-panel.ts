// The calibration panel: which models measure each family's difficulty, with what solver settings,
// under which ladder and band. A panel is frozen before a run (its routes checked, its contents
// hashed) and never changes afterwards: attempts only pool with attempts from the same frozen
// panel, model, prompt and verifier.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARBOR_VERSION, WORK_DIR } from './lib/config.ts';
import { fileExists, readJson, writeJson } from './lib/util.ts';
import { checkRoutes } from './calibrate-gateway.ts';
import type { RouteCheck } from './calibrate-gateway.ts';
import type { SolverModel } from './calibrate-harbor.ts';
import { DEFAULT_BAND, DEFAULT_LADDER } from './calibrate-ladder.ts';
import type { BandConfig, Family, LadderConfig } from './calibrate-ladder.ts';

export const CALIBRATION_DIR = join(WORK_DIR, 'calibration');
export const PANELS_DIR = join(CALIBRATION_DIR, 'panels');

export interface PanelModel extends SolverModel {
  family: Family;
  tier: 'cheap' | 'strong';
  /** Prior for the budget gate until this run has observed the model's real attempt cost. */
  est_attempt_usd: number;
}

export interface PanelFamily {
  family: Family;
  cheap: string | null;
  strong: string | null;
  /** The one model this family's difficulty is measured on. Null leaves the slot empty. */
  ladder: string | null;
  note?: string;
}

export interface Panel {
  id: string;
  harness: 'terminus-2';
  harbor_version: string;
  /** terminus-2 options for every attempt (the solver's prompt and loop settings). */
  agent_kwargs: Record<string, unknown>;
  agent_timeout_sec: number;
  families: PanelFamily[];
  /** The family whose pass rate caps the band. */
  frontier: Family;
  /** One attempt from each before the ladder. A screen attempt on a ladder model is that ladder's first try. */
  screen: { cheap: string; frontier: string };
  ladder: LadderConfig;
  band: BandConfig;
  /** Budget gate reserve per attempt, as a share of the estimated attempt cost. */
  reserve_factor: number;
  models: Record<string, PanelModel>;
  /** Models that take `max_completion_tokens` instead of `max_tokens` (route checks only). */
  completion_tokens_models: string[];
}

export interface FrozenPanel extends Panel {
  frozen_at: string;
  sha: string;
  routes: RouteCheck[];
}

const M = 1e-6;

/**
 * The dev panel: one cheap and one strong model per family on the gateway today. Each family's
 * difficulty is measured on one model. Claude is the frontier family and is measured on its strong
 * model, so the band's ceiling means something; GPT and open weights are measured on their cheap
 * models so a full 16-attempt ladder stays affordable. Gemini's slot is empty until its key works.
 */
export function defaultPanel(id = 'cal-v1'): Panel {
  const models: Record<string, PanelModel> = {
    'claude-haiku-4-5': { model: 'claude-haiku-4-5', family: 'anthropic', tier: 'cheap', max_input_tokens: 200_000, max_output_tokens: 64_000, pricing: { input: 1 * M, output: 5 * M, cache_read: 0.1 * M, cache_write: 1.25 * M }, est_attempt_usd: 0.3 },
    'claude-sonnet-5': { model: 'claude-sonnet-5', family: 'anthropic', tier: 'strong', max_input_tokens: 1_000_000, max_output_tokens: 128_000, pricing: { input: 2 * M, output: 10 * M, cache_read: 0.2 * M, cache_write: 2.5 * M }, est_attempt_usd: 0.5 },
    'gpt-6-luna': { model: 'gpt-6-luna', family: 'openai', tier: 'cheap', max_input_tokens: 922_000, max_output_tokens: 128_000, pricing: { input: 0.1 * M, output: 0.5 * M, cache_read: 0.01 * M, cache_write: 0.125 * M }, est_attempt_usd: 0.02 },
    'gpt-5.4-mini': { model: 'gpt-5.4-mini', family: 'openai', tier: 'strong', max_input_tokens: 272_000, max_output_tokens: 128_000, pricing: { input: 0.75 * M, output: 4.5 * M, cache_read: 0.075 * M }, est_attempt_usd: 0.1 },
    'cf-kimi-k2.7-code': { model: 'cf-kimi-k2.7-code', family: 'open', tier: 'cheap', max_input_tokens: 128_000, pricing: { input: 0.95 * M, output: 4 * M }, est_attempt_usd: 0.4 },
    'cf-glm-5.2': { model: 'cf-glm-5.2', family: 'open', tier: 'strong', max_input_tokens: 128_000, pricing: { input: 1.4 * M, output: 4.4 * M }, est_attempt_usd: 0.5 },
  };
  return {
    id,
    harness: 'terminus-2',
    harbor_version: HARBOR_VERSION,
    agent_kwargs: { parser_name: 'json', record_terminal_session: false, max_turns: 40, suppress_max_turns_warning: true },
    agent_timeout_sec: 900,
    families: [
      { family: 'anthropic', cheap: 'claude-haiku-4-5', strong: 'claude-sonnet-5', ladder: 'claude-sonnet-5' },
      { family: 'openai', cheap: 'gpt-6-luna', strong: 'gpt-5.4-mini', ladder: 'gpt-6-luna' },
      { family: 'open', cheap: 'cf-kimi-k2.7-code', strong: 'cf-glm-5.2', ladder: 'cf-kimi-k2.7-code' },
      { family: 'google', cheap: null, strong: null, ladder: null, note: 'slot held: the gateway has no working Gemini key' },
    ],
    frontier: 'anthropic',
    screen: { cheap: 'gpt-6-luna', frontier: 'claude-sonnet-5' },
    ladder: DEFAULT_LADDER,
    band: DEFAULT_BAND,
    reserve_factor: 0.5,
    models,
    completion_tokens_models: ['gpt-6-luna', 'gpt-5.4-mini'],
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function panelSha(p: Panel): string {
  return createHash('sha256').update(canonical(p)).digest('hex').slice(0, 16);
}

/** The fields that belong to the panel itself, without the freeze record. */
export function panelBody(p: Panel | FrozenPanel): Panel {
  const { frozen_at: _a, sha: _b, routes: _c, ...body } = p as FrozenPanel;
  return body;
}

export function validatePanel(p: Panel): void {
  const ladderModels = p.families.filter((f) => f.ladder).map((f) => f.ladder as string);
  for (const f of p.families) {
    for (const m of [f.cheap, f.strong, f.ladder]) {
      if (m && !p.models[m]) throw new Error(`panel ${p.id}: ${f.family} names unknown model ${m}`);
      if (m && p.models[m].family !== f.family) throw new Error(`panel ${p.id}: ${m} is not a ${f.family} model`);
    }
  }
  if (!p.families.some((f) => f.family === p.frontier && f.ladder)) throw new Error(`panel ${p.id}: frontier family ${p.frontier} has no ladder model`);
  for (const m of [p.screen.cheap, p.screen.frontier]) if (!p.models[m]) throw new Error(`panel ${p.id}: screen model ${m} is not on the panel`);
  if (new Set(ladderModels).size !== ladderModels.length) throw new Error(`panel ${p.id}: a model measures two families`);
  const stages = p.ladder.stages;
  if (!stages.length || stages.some((s, i) => s <= 0 || (i > 0 && s <= stages[i - 1]))) throw new Error(`panel ${p.id}: ladder stages must be positive and ascending`);
}

export function panelPath(id: string): string {
  return join(PANELS_DIR, `${id}.json`);
}

export function loadFrozenPanel(idOrPath: string): FrozenPanel {
  const path = idOrPath.endsWith('.json') ? idOrPath : panelPath(idOrPath);
  if (!fileExists(path)) throw new Error(`no frozen panel at ${path}; freeze it first (calibrate.ts freeze)`);
  const p = readJson<FrozenPanel>(path);
  const sha = panelSha(panelBody(p));
  if (sha !== p.sha) throw new Error(`panel ${p.id} was edited after it was frozen (sha ${sha} != ${p.sha}); freeze a new panel id instead`);
  return p;
}

/**
 * Check every panel model's route, then write the frozen panel. Refuses when a ladder or screen
 * model does not answer, and when a different panel was already frozen under the same id.
 */
export async function freezePanel(input: Panel, opts: { gatewayUrl: string; key: string }): Promise<FrozenPanel> {
  const panel = panelBody(input);
  validatePanel(panel);
  const sha = panelSha(panel);
  const path = panelPath(panel.id);
  if (fileExists(path)) {
    const existing = readJson<FrozenPanel>(path);
    if (existing.sha !== sha) throw new Error(`panel ${panel.id} is already frozen with sha ${existing.sha}; results never pool across panels, so use a new id`);
    return existing;
  }
  const models = [...new Set(panel.families.flatMap((f) => [f.cheap, f.strong]).filter((m): m is string => Boolean(m)))];
  const routes = await checkRoutes(opts.gatewayUrl, opts.key, models, { completionTokensModels: panel.completion_tokens_models, tag: `freeze:${panel.id}` });
  const needed = new Set([...panel.families.map((f) => f.ladder).filter((m): m is string => Boolean(m)), panel.screen.cheap, panel.screen.frontier]);
  const dead = routes.filter((r) => !r.ok && needed.has(r.model));
  if (dead.length) throw new Error(`cannot freeze ${panel.id}: no answer from ${dead.map((r) => `${r.model} (${r.status ?? ''} ${r.detail ?? ''})`).join('; ')}`);
  const frozen: FrozenPanel = { ...panel, frozen_at: new Date().toISOString(), sha, routes };
  writeJson(path, frozen);
  return frozen;
}

export function readPanelFile(path: string): Panel {
  return JSON.parse(readFileSync(path, 'utf8')) as Panel;
}
