import { startSimulator } from './runner.js';

/**
 * Feed simulated rows into a running worker:
 *
 *   BUGFARM_URL=http://localhost:8095 BUGFARM_INGEST_TOKEN=... BUGFARM_SIM_SPEED=1 pnpm sim
 *
 * Development and screen tests only. The board shows a banner while any
 * simulated row is current.
 */

const url = process.env.BUGFARM_URL ?? `http://localhost:${process.env.BUGFARM_PORT ?? 8095}`;
const token = process.env.BUGFARM_INGEST_TOKEN ?? '';
const speed = Number(process.env.BUGFARM_SIM_SPEED ?? '1');
const seed = process.env.BUGFARM_SIM_SEED ? Number(process.env.BUGFARM_SIM_SEED) : undefined;

if (!token) {
  console.error('[bugfarm-sim] set BUGFARM_INGEST_TOKEN to the worker\'s ingest token');
  process.exit(1);
}

const sim = await startSimulator({ baseUrl: url, token, speed: Number.isFinite(speed) && speed > 0 ? speed : 1, seed });
if (!sim.running) process.exit(1);
process.once('SIGINT', () => {
  sim.stop();
  process.exit(0);
});
