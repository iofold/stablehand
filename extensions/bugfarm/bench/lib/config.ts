// Benchmark configuration: the cell list (cells.json), the settings a run reads from the
// environment, and the frozen bench definition every attempt is measured against.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDotenv } from '../../pipeline/calibrate-gateway.ts';

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BUGFARM_DIR = resolve(BENCH_DIR, '..');
export const HARBOR_PKG_DIR = join(BUGFARM_DIR, 'harbor');
/** Everything a bench writes lives here (gitignored). Absolute, because Harbor needs absolute job dirs. */
export const BENCH_WORK = resolve(process.env.BUGFARM_BENCH_WORK ?? join(BENCH_DIR, '.work'));
export const DEFAULT_CELLS_FILE = join(BENCH_DIR, 'cells.json');

export type AgentKind = 'stablehand' | 'terminus-2';

export interface ModelSpec {
  family: string;
  max_input_tokens: number;
  max_output_tokens?: number;
  usd_per_mtok: { input: number; output: number; cache_read?: number; cache_write?: number };
  /** Extra kwargs for every terminus-2 LLM call of this model. */
  call_kwargs?: Record<string, unknown>;
}

export interface CellSpec {
  /** Also the `bench_cell` tag on every turn and model call. */
  id: string;
  enabled?: boolean;
  agent: AgentKind;
  /** Stablehand harness for stablehand cells: claude-agents, pi or langgraph. */
  harness?: string;
  model: string;
  /** Prior attempt cost for the budget gate, until the run has seen two attempts of this cell. */
  est_attempt_usd: number;
  /** StablehandAgent: `all` (default, the project rule) or `none` (task_* tools only). */
  native_tools?: 'all' | 'none';
  /** More StablehandAgent kwargs (harness_config, max_tool_calls, ...). */
  agent_kwargs?: Record<string, unknown>;
  /** Shown on the leaderboard and in the dataset card. */
  notes?: string[];
}

export interface CellsConfig {
  defaults: { k: number; concurrency: number; agent_timeout_sec: number; max_cost_usd_per_trial: number; reserve_factor: number };
  terminus2_kwargs: Record<string, unknown>;
  models: Record<string, ModelSpec>;
  cells: CellSpec[];
}

/** A cell as measured: its spec plus everything that decides how it runs. Hashed into the bench. */
export interface ResolvedCell extends CellSpec {
  harness_label: string;
  family: string;
  model_spec: ModelSpec;
  agent_timeout_sec: number;
  max_cost_usd_per_trial: number;
  terminus2_kwargs?: Record<string, unknown>;
  notes: string[];
  sha: string;
}

const STABLEHAND_HARNESSES: Record<string, string> = { 'claude-agents': 'claude-agents', claude: 'claude-agents', pi: 'pi-agent', 'pi-agent': 'pi-agent', langgraph: 'langgraph' };

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function sha16(v: unknown): string {
  return createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex').slice(0, 16);
}

export function loadCellsConfig(path = DEFAULT_CELLS_FILE): CellsConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CellsConfig>;
  if (!raw.cells?.length) throw new Error(`${path}: no cells`);
  if (!raw.models) throw new Error(`${path}: no models`);
  const d = raw.defaults ?? ({} as CellsConfig['defaults']);
  const cfg: CellsConfig = {
    defaults: { k: d.k ?? 3, concurrency: d.concurrency ?? 6, agent_timeout_sec: d.agent_timeout_sec ?? 1200, max_cost_usd_per_trial: d.max_cost_usd_per_trial ?? 2, reserve_factor: d.reserve_factor ?? 0.5 },
    terminus2_kwargs: raw.terminus2_kwargs ?? {},
    models: raw.models,
    cells: raw.cells,
  };
  const ids = new Set<string>();
  for (const c of cfg.cells) {
    if (!c.id || !/^[A-Za-z0-9._/-]{1,120}$/.test(c.id)) throw new Error(`${path}: bad cell id ${JSON.stringify(c.id)}`);
    if (ids.has(c.id)) throw new Error(`${path}: duplicate cell ${c.id}`);
    ids.add(c.id);
    if (c.agent !== 'stablehand' && c.agent !== 'terminus-2') throw new Error(`${path}: cell ${c.id}: agent must be stablehand or terminus-2`);
    if (c.agent === 'stablehand' && !STABLEHAND_HARNESSES[c.harness ?? '']) throw new Error(`${path}: cell ${c.id}: unknown Stablehand harness ${c.harness}`);
    if (!cfg.models[c.model]) throw new Error(`${path}: cell ${c.id}: model ${c.model} has no entry under "models"`);
    if (c.agent === 'stablehand' && STABLEHAND_HARNESSES[c.harness ?? ''] === 'claude-agents' && cfg.models[c.model].family !== 'anthropic') {
      throw new Error(`${path}: cell ${c.id}: the claude-agents harness runs Anthropic models only`);
    }
    if (!(c.est_attempt_usd > 0)) throw new Error(`${path}: cell ${c.id}: est_attempt_usd must be positive`);
  }
  return cfg;
}

export function resolveCell(cfg: CellsConfig, c: CellSpec, overrides: { agent_timeout_sec?: number; max_cost_usd_per_trial?: number } = {}): ResolvedCell {
  const model = cfg.models[c.model];
  const harness = c.agent === 'stablehand' ? STABLEHAND_HARNESSES[c.harness as string] : 'terminus-2';
  const notes = [...(c.notes ?? [])];
  if (c.agent === 'stablehand' && c.native_tools === 'none' && !notes.some((n) => /native tools off/i.test(n))) {
    notes.unshift('Harness-native tools off for this cell (only the task_* tools); the project default keeps them on.');
  }
  const body = {
    id: c.id,
    agent: c.agent,
    harness: c.agent === 'stablehand' ? harness : undefined,
    model: c.model,
    est_attempt_usd: c.est_attempt_usd,
    native_tools: c.agent === 'stablehand' ? c.native_tools ?? 'all' : undefined,
    agent_kwargs: c.agent_kwargs,
    model_spec: model,
    agent_timeout_sec: overrides.agent_timeout_sec ?? cfg.defaults.agent_timeout_sec,
    max_cost_usd_per_trial: overrides.max_cost_usd_per_trial ?? cfg.defaults.max_cost_usd_per_trial,
    terminus2_kwargs: c.agent === 'terminus-2' ? cfg.terminus2_kwargs : undefined,
  };
  return {
    ...c,
    harness,
    harness_label: c.agent === 'stablehand' ? `Stablehand ${harness}` : 'Harbor terminus-2',
    family: model.family,
    model_spec: model,
    native_tools: body.native_tools,
    agent_timeout_sec: body.agent_timeout_sec,
    max_cost_usd_per_trial: body.max_cost_usd_per_trial,
    terminus2_kwargs: body.terminus2_kwargs,
    notes,
    sha: sha16(body),
  };
}

/** Filesystem-safe form of a cell id. */
export function cellSlug(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_');
}

// ---------------------------------------------------------------------------------------------
// Settings from the environment (secrets are read, never printed)

export interface Settings {
  stablehandUrl: string;
  /** The master STABLEHAND_API_TOKEN: StablehandAgent creates solver agents, budgets and campaign keys are master-only. */
  stablehandToken?: string;
  gatewayUrl: string;
  meteringKey?: string;
  runtimeKey?: string;
  boardUrl?: string;
  boardToken?: string;
  boardPublicUrl?: string;
  harborBin: string;
  stablehandUiUrl?: string;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const stackEnv = env.BUGFARM_STABLEHAND_ENV ?? join(homedir(), 'stablehand', '.env');
  const dot = existsSync(stackEnv) ? readDotenv(stackEnv) : {};
  return {
    stablehandUrl: (env.STABLEHAND_URL ?? env.STABLEHAND_API_URL ?? 'http://localhost:3002').replace(/\/+$/, ''),
    stablehandToken: env.STABLEHAND_API_TOKEN ?? dot.STABLEHAND_API_TOKEN,
    gatewayUrl: (env.BUGFARM_GATEWAY_URL ?? 'http://localhost:4400').replace(/\/+$/, ''),
    meteringKey: env.BUGFARM_GATEWAY_METERING_KEY ?? dot.STABLEHAND_MODEL_GATEWAY_METERING_KEY,
    runtimeKey: dot.STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY,
    boardUrl: env.BUGFARM_URL?.replace(/\/+$/, ''),
    boardToken: env.BUGFARM_INGEST_TOKEN,
    boardPublicUrl: env.BUGFARM_BOARD_URL?.replace(/\/+$/, ''),
    harborBin: env.BUGFARM_BENCH_HARBOR ?? join(HARBOR_PKG_DIR, '.venv', 'bin', 'harbor'),
    stablehandUiUrl: env.STABLEHAND_UI_URL?.replace(/\/+$/, ''),
  };
}
