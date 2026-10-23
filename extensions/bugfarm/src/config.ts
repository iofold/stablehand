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
  };
}
