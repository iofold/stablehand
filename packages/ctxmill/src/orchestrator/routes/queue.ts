import type { FastifyInstance } from 'fastify';

import type { DatabaseRepository } from '../../database/repository.js';
import type { TurnDispatcher } from '../turn-dispatcher.js';

export interface QueueRouteOptions {
  db: Pick<DatabaseRepository, 'countQueuedTurns' | 'getOldestQueuedTurnAgeMs'>;
  dispatcher?: Pick<TurnDispatcher, 'isStalled' | 'getLastPassCompletedAt'>;
}

/**
 * Queue observability (ctx-z5k0): depth, oldest age, and dispatcher health —
 * the fpi1 "degraded, never silent" pattern applied to turn admission.
 */
export async function queueRoutes(app: FastifyInstance, opts: QueueRouteOptions): Promise<void> {
  const { db, dispatcher } = opts;

  app.get('/status', async () => {
    const [counts, oldestAgeMs] = await Promise.all([
      db.countQueuedTurns(''),
      db.getOldestQueuedTurnAgeMs(),
    ]);
    const stalled = dispatcher ? dispatcher.isStalled() : null;
    return {
      queuedTurns: counts.global,
      oldestQueuedAgeMs: oldestAgeMs,
      dispatcher: {
        stalled,
        lastPassCompletedAt: dispatcher?.getLastPassCompletedAt() ?? null,
      },
      state: stalled && counts.global > 0 ? 'degraded' : 'healthy',
    };
  });
}
