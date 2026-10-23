import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { ChangeHub } from './hub.js';
import { createBugfarmServer } from './server.js';
import { StablehandLink } from './stablehand.js';
import { BoardStore } from './store/store.js';
import { startSimulator, type RunningSimulator } from './sim/runner.js';

/**
 * Bugfarm worker. Runs beside Stablehand as its own process:
 * - keeps the board store (append-only rows in its own Postgres schema),
 * - serves the board page, `/api/state`, `/api/changes` and `/api/stream`,
 * - takes pipeline writes on the token-protected ingest API,
 * - receives signed Stablehand webhooks for the floor agents.
 */

function resolveWebDir(configured: string | null): string | null {
  if (configured) return configured;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled: dist/server/main.js → dist/web. From source: src/main.ts → dist/web.
  for (const candidate of [path.resolve(here, '../web'), path.resolve(here, '../dist/web')]) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error('[bugfarm] BUGFARM_DATABASE_URL is not set. The board keeps its rows in Postgres; point it at a database or schema the worker owns.');
    process.exit(1);
  }

  let ingestToken = config.ingestToken;
  if (!ingestToken && config.sim) {
    ingestToken = randomBytes(24).toString('hex');
    console.log('[bugfarm] simulator on: minted a one-off ingest token for this process');
  }

  const store = new BoardStore({ url: config.databaseUrl, schema: config.dbSchema });
  await store.migrate();
  const hub = new ChangeHub(store);
  await hub.start();

  const link = new StablehandLink({
    baseUrl: config.stablehandBaseUrl,
    apiKey: config.stablehandApiKey,
    webhookSecret: config.webhookSecret,
    publicUrl: config.publicUrl,
    agentIds: config.agentIds,
  });

  let simulator: RunningSimulator | null = null;
  const webDir = resolveWebDir(config.webDir);
  const server = createBugfarmServer({
    store,
    hub,
    ingestToken,
    viewToken: config.viewToken,
    webhookSecret: config.webhookSecret,
    campaignKey: config.campaignKey,
    webDir,
    link: () => link.status,
    sim: () => (config.sim ? { running: simulator?.running ?? false } : null),
  });

  // Writes from other processes sharing this schema reach the stream too.
  const stopListening = await store.listen((signal) => {
    if (signal.startsWith('reset:')) void hub.reset(signal.slice('reset:'.length));
    else void hub.poke();
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[bugfarm] board on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} (schema ${config.dbSchema}, ingest ${ingestToken ? 'on' : 'off'}${webDir ? '' : ', page not built'})`);

  if (link.status.missing.length > 0) {
    console.log(`[bugfarm] not connected to Stablehand (set ${link.status.missing.join(', ')}); the board still takes pipeline writes`);
  } else {
    const connect = async () => {
      const status = await link.connect();
      if (status.connected) console.log(`[bugfarm] Stablehand connected; webhooks on ${status.webhookAgents.length} floor agent(s)`);
      else if (status.lastError) console.warn(`[bugfarm] ${status.lastError}; retrying in 30 s`);
      return status.connected;
    };
    void (async () => {
      while (!(await connect())) await new Promise((resolve) => setTimeout(resolve, 30_000).unref());
    })();
  }

  if (config.sim) {
    simulator = await startSimulator({
      baseUrl: `http://127.0.0.1:${config.port}`,
      token: ingestToken,
      speed: config.simSpeed,
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`[bugfarm] ${signal}: shutting down`);
    simulator?.stop();
    server.close();
    await stopListening().catch((err: unknown) => console.warn('[bugfarm] stopping the change listener failed:', err));
    await store.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err: unknown) => {
  console.error('[bugfarm] failed to start:', err);
  process.exit(1);
});
