/** Worker configuration, read once from the environment. */

export interface BugfarmConfig {
  port: number;
  host: string;
  databaseUrl: string;
  dbSchema: string;
  /** Bearer token for the internal ingest API. Empty disables ingest (unless the simulator mints one). */
  ingestToken: string;
  /** Optional: when set, the board asks for it once and remembers it in a cookie. */
  viewToken: string;
  publicUrl: string;
  stablehandBaseUrl: string;
  stablehandApiKey: string;
  webhookSecret: string;
  agentIds: string[];
  /** Campaign row that webhook updates land on. */
  campaignKey: string;
  sim: boolean;
  simSpeed: number;
  webDir: string | null;
  /** Bearer secret for the floor agents' HTTP tools. Empty turns the tools off. */
  toolsToken: string;
  /** Floor agents by role; the foreman finds them by name. */
  agentNames: { scout: string; env_builder: string; writer: string };
  /** Concurrent pipeline jobs per kind. */
  checkConcurrency: number;
  controlsConcurrency: number;
  /** Set to 0 to run the board and tools without driving campaigns. */
  foreman: boolean;
}

function intFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): BugfarmConfig {
  const port = intFrom(env.BUGFARM_PORT, 8095);
  const speed = Number(env.BUGFARM_SIM_SPEED ?? '1');
  return {
    port,
    host: env.BUGFARM_HOST ?? '0.0.0.0',
    databaseUrl: env.BUGFARM_DATABASE_URL ?? '',
    dbSchema: env.BUGFARM_DB_SCHEMA ?? 'bugfarm',
    ingestToken: env.BUGFARM_INGEST_TOKEN ?? '',
    viewToken: env.BUGFARM_VIEW_TOKEN ?? '',
    publicUrl: (env.BUGFARM_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    stablehandBaseUrl: (env.STABLEHAND_BASE_URL ?? '').replace(/\/+$/, ''),
    stablehandApiKey: env.STABLEHAND_API_KEY ?? '',
    webhookSecret: env.BUGFARM_WEBHOOK_SECRET ?? '',
    agentIds: (env.BUGFARM_AGENT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
    campaignKey: env.BUGFARM_CAMPAIGN ?? 'main',
    sim: env.BUGFARM_SIM === '1' || env.BUGFARM_SIM === 'true',
    simSpeed: Number.isFinite(speed) && speed > 0 ? speed : 1,
    webDir: env.BUGFARM_WEB_DIR ?? null,
    toolsToken: env.BUGFARM_TOOLS_TOKEN ?? '',
    agentNames: {
      scout: env.BUGFARM_SCOUT_AGENT ?? 'bugfarm-scout',
      env_builder: env.BUGFARM_ENV_BUILDER_AGENT ?? 'bugfarm-env-builder',
      writer: env.BUGFARM_WRITER_AGENT ?? 'bugfarm-writer',
    },
    checkConcurrency: intFrom(env.BUGFARM_CHECK_CONCURRENCY, 3),
    controlsConcurrency: intFrom(env.BUGFARM_CONTROLS_CONCURRENCY, 2),
    foreman: env.BUGFARM_FOREMAN !== '0' && env.BUGFARM_FOREMAN !== 'false',
  };
}
