import type { UpsertInput } from '../store/validate.js';
import { SimWorld } from './world.js';

/**
 * Drives a SimWorld against a worker's ingest API, the same API the real
 * pipeline uses. For development and screen tests only.
 *
 * It refuses to run on a board that holds real rows, and it clears earlier
 * simulated rows before seeding, so simulated data never mixes with a run.
 */

export interface SimulatorOptions {
  baseUrl: string;
  token: string;
  speed?: number;
  seed?: number;
  tickMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, 'log' | 'warn'>;
}

export interface RunningSimulator {
  readonly running: boolean;
  stop(): void;
}

interface Health {
  board?: { realKeys: number; simulatedKeys: number } | null;
}

export async function startSimulator(options: SimulatorOptions): Promise<RunningSimulator> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console;
  const base = options.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' };
  let running = false;

  const post = async (pathname: string, body: unknown): Promise<void> => {
    const res = await fetchImpl(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${pathname} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
  const send = (rows: UpsertInput[]) => post('/internal/v1/rows', { rows });

  const health = await fetchImpl(`${base}/healthz`).then((res) => res.json() as Promise<Health>);
  if ((health.board?.realKeys ?? 0) > 0) {
    logger.warn('[bugfarm-sim] the board holds rows from a real run; the simulator will not write next to them');
    return { running: false, stop: () => undefined };
  }
  if ((health.board?.simulatedKeys ?? 0) > 0) {
    await post('/internal/v1/reset', { confirm: 'erase-board', scope: 'simulated' });
  }

  const world = new SimWorld({ seed: options.seed, speed: options.speed });
  for (const chunk of world.seed(Date.now())) await send(chunk);
  running = true;
  logger.log(`[bugfarm-sim] simulated campaign seeded; streaming at ${options.speed ?? 1}x`);

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    const rows = world.tick(Date.now());
    const write = rows.length > 0 ? send(rows) : Promise.resolve();
    write
      .catch((err: unknown) => logger.warn('[bugfarm-sim] write failed:', (err as Error).message))
      .finally(() => {
        busy = false;
      });
  }, options.tickMs ?? 400);

  return {
    get running() {
      return running;
    },
    stop() {
      running = false;
      clearInterval(timer);
    },
  };
}
