import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envContext } from '../pipeline/lib/build-env.ts';
import { DEFAULT_PANEL, pendingCalibration } from './calibrate.js';
import { loadConfig } from './config.js';
import { StablehandFloorApi } from './floor/api.js';
import { loadItemContext } from './foreman/context.js';
import { campaignConfigFrom } from './foreman/launch.js';
import { Foreman } from './foreman/foreman.js';
import { ChangeHub } from './hub.js';
import { createPipelineHandlers } from './jobs/pipeline-jobs.js';
import { JobRunner } from './jobs/runner.js';
import { createBugfarmServer } from './server.js';
import { StablehandLink } from './stablehand.js';
import { BoardStore } from './store/store.js';
import { startSimulator, type RunningSimulator } from './sim/runner.js';
import { createToolHandlers } from './tools.js';

/**
 * Bugfarm worker. Runs beside Stablehand as its own process:
 * - keeps the board store (append-only rows in its own Postgres schema),
 * - serves the board page, `/api/state`, `/api/changes` and `/api/stream`,
 * - takes pipeline writes on the token-protected ingest API,
 * - runs pipeline jobs (env builds, checks, packaging, controls) and exposes them to the floor
 *   agents as HTTP tools,
 * - runs the foreman, which drives campaigns through Stablehand turns and resumes them after a
 *   restart,
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

  const store = new BoardStore({ url: config.databaseUrl, schema: config.dbSchema, maxConnections: 10 });
  await store.migrate();
  const hub = new ChangeHub(store);
  await hub.start();

  const floor = config.stablehandBaseUrl && config.stablehandApiKey
    ? new StablehandFloorApi({ baseUrl: config.stablehandBaseUrl, token: config.stablehandApiKey })
    : null;
  const jobs = new JobRunner({
    store,
    handlers: createPipelineHandlers({ store }),
    limits: { build_env: 2, check_candidate: config.checkConcurrency, package_task: 2, run_controls: config.controlsConcurrency },
    // A foreman job's progress is what its card is doing right now.
    onProgress: async (job, message) => {
      if (job.owner === 'foreman' && job.item) await store.upsert([{ kind: 'item', key: job.item, payload: { activity: message.slice(0, 200) } }]);
    },
  });
  const foreman = floor && config.foreman
    ? new Foreman({
      store,
      jobs,
      floor,
      agentNames: config.agentNames,
      calibrate: pendingCalibration,
      panel: DEFAULT_PANEL,
      envContext,
      itemContext: loadItemContext,
    })
    : null;
  const tools = config.toolsToken ? createToolHandlers({ jobs, store, floor, itemContext: loadItemContext }) : null;

  let link: StablehandLink | null = null;
  let lastCampaign = config.campaignKey;
  let simulator: RunningSimulator | null = null;
  const webDir = resolveWebDir(config.webDir);
  const server = createBugfarmServer({
    store,
    hub,
    ingestToken,
    viewToken: config.viewToken,
    webhookSecret: config.webhookSecret,
    campaignKey: () => foreman?.running[0] ?? lastCampaign,
    webDir,
    link: () => link?.status ?? null,
    sim: () => (config.sim ? { running: simulator?.running ?? false } : null),
    tools,
    toolsToken: config.toolsToken,
    launchCampaign: foreman
      ? async (body) => {
        const { id, config: campaignConfig } = campaignConfigFrom(body);
        await foreman.launch(id, campaignConfig);
        lastCampaign = id;
        return { id, config: campaignConfig };
      }
      : undefined,
    foreman: () => (foreman ? { running: foreman.running } : null),
  });

  // Writes from other processes sharing this schema reach the stream too.
  const stopListening = await store.listen((signal) => {
    if (signal.startsWith('reset:')) void hub.reset(signal.slice('reset:'.length));
    else void hub.poke();
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[bugfarm] board on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} (schema ${config.dbSchema}, ingest ${ingestToken ? 'on' : 'off'}, tools ${tools ? 'on' : 'off'}, foreman ${foreman ? 'on' : 'off'}${webDir ? '' : ', page not built'})`);

  const resumedJobs = await jobs.resume();
  if (resumedJobs > 0) console.log(`[bugfarm] jobs: resumed ${resumedJobs} job(s) left running by the previous process`);
  if (foreman) {
    const resumed = await foreman.resumeAll();
    if (resumed.length > 0) lastCampaign = resumed[0];
  }

  const connectLink = async (): Promise<boolean> => {
    if (!link) {
      let agentIds = config.agentIds;
      if (agentIds.length === 0 && floor) {
        const found = await Promise.all(Object.values(config.agentNames).map((name) => floor.findAgentByName(name)));
        agentIds = found.filter((id): id is string => Boolean(id));
      }
      link = new StablehandLink({
        baseUrl: config.stablehandBaseUrl,
        apiKey: config.stablehandApiKey,
        webhookSecret: config.webhookSecret,
        publicUrl: config.publicUrl,
        agentIds,
      });
      if (link.status.missing.length > 0) {
        console.log(`[bugfarm] webhooks off (set ${link.status.missing.join(', ')}); the foreman and the board work without them`);
        return true;
      }
    }
    const status = await link.connect();
    if (status.connected) console.log(`[bugfarm] Stablehand connected; webhooks on ${status.webhookAgents.length} floor agent(s)`);
    else if (status.lastError) console.warn(`[bugfarm] ${status.lastError}; retrying in 30 s`);
    return status.connected;
  };
  void (async () => {
    for (;;) {
      try {
        if (await connectLink()) return;
      } catch (err) {
        console.warn('[bugfarm] connecting to Stablehand failed; retrying in 30 s:', (err as Error).message);
        link = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000).unref());
    }
  })();

  if (config.sim) {
    simulator = await startSimulator({
      baseUrl: `http://127.0.0.1:${config.port}`,
      token: ingestToken,
      speed: config.simSpeed,
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`[bugfarm] ${signal}: shutting down; running campaigns and jobs resume on the next start`);
    simulator?.stop();
    jobs.stop();
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
