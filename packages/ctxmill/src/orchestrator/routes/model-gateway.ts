import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ModelGatewayQuarantineSchema,
  ModelGatewayStatusSchema,
} from '@ctxmill/contracts';

import type { DatabaseRepository } from '../../database/repository.js';

type ModelGatewayStatusStore = Pick<
  DatabaseRepository,
  | 'getModelGatewayReconciliationState'
  | 'getModelGatewayReconciliationMetrics'
  | 'getModelGatewayQuarantineSummary'
>;

export type ModelGatewayStatusConfig =
  | { enabled: false }
  | { enabled: true; profile: string; revision: string };

interface ModelGatewayRouteOptions {
  db: ModelGatewayStatusStore;
  config: ModelGatewayStatusConfig;
  now?: () => number;
  degradedLagMs?: number;
}

const DEFAULT_DEGRADED_LAG_MS = 2 * 60_000;
const DEFAULT_QUARANTINE_RECENT_MS = 24 * 60 * 60_000;
const DEFAULT_QUARANTINE_LIMIT = 20;
const MAX_QUARANTINE_LIMIT = 100;

export async function modelGatewayRoutes(
  app: FastifyInstance,
  opts: ModelGatewayRouteOptions,
): Promise<void> {
  app.get('/status', async () => {
    if (!opts.config.enabled) {
      return ModelGatewayStatusSchema.parse({
        enabled: false,
        profile: null,
        revision: null,
        state: 'disabled',
        watermarkAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lagMs: null,
        lastError: null,
        pendingCalls: 0,
        unpricedCalls: 0,
        quarantinedTransactions: 0,
        orphanTransactions: 0,
      });
    }

    const [reconciliation, metrics] = await Promise.all([
      opts.db.getModelGatewayReconciliationState(opts.config.profile),
      opts.db.getModelGatewayReconciliationMetrics(opts.config.profile),
    ]);
    const now = (opts.now ?? Date.now)();
    const watermarkAt = reconciliation?.watermarkMs
      ? reconciliation.watermarkMs
      : null;
    const lagMs = watermarkAt === null
      ? null
      : Math.max(0, now - watermarkAt);
    const state = !reconciliation?.lastSuccessAt
      ? reconciliation?.lastError
        ? 'degraded'
        : 'initializing'
      : reconciliation.lastError
        || lagMs === null
        || lagMs > (opts.degradedLagMs ?? DEFAULT_DEGRADED_LAG_MS)
        ? 'degraded'
        : 'healthy';

    return ModelGatewayStatusSchema.parse({
      enabled: true,
      profile: opts.config.profile,
      revision: opts.config.revision,
      state,
      watermarkAt,
      lastAttemptAt: reconciliation?.lastAttemptAt ?? null,
      lastSuccessAt: reconciliation?.lastSuccessAt ?? null,
      lagMs,
      lastError: reconciliation?.lastError ?? null,
      ...metrics,
    });
  });

  app.get(
    '/quarantine',
    async (
      request: FastifyRequest<{ Querystring: { since?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      if (!opts.config.enabled) {
        return ModelGatewayQuarantineSchema.parse({
          enabled: false,
          profile: null,
          recentSince: null,
          total: 0,
          recentTotal: 0,
          reasons: [],
          recent: [],
        });
      }

      const now = (opts.now ?? Date.now)();
      const sinceRaw = request.query.since;
      const since = sinceRaw === undefined ? now - DEFAULT_QUARANTINE_RECENT_MS : Number(sinceRaw);
      if (!Number.isSafeInteger(since) || since < 0) {
        return reply.status(400).send({
          error: 'since must be a nonnegative epoch-milliseconds integer',
        });
      }
      const limitRaw = request.query.limit;
      const limit = limitRaw === undefined ? DEFAULT_QUARANTINE_LIMIT : Number(limitRaw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUARANTINE_LIMIT) {
        return reply.status(400).send({
          error: `limit must be an integer between 1 and ${MAX_QUARANTINE_LIMIT}`,
        });
      }

      const summary = await opts.db.getModelGatewayQuarantineSummary(
        opts.config.profile,
        { recentSinceMs: since, limit },
      );

      return ModelGatewayQuarantineSchema.parse({
        enabled: true,
        profile: opts.config.profile,
        recentSince: since,
        total: summary.reasons.reduce((sum, row) => sum + row.total, 0),
        recentTotal: summary.reasons.reduce((sum, row) => sum + row.recentTotal, 0),
        reasons: summary.reasons,
        recent: summary.recent,
      });
    },
  );
}
