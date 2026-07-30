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
  | 'getGatewayTurnsAwaitingReconciliation'
>;

export type ModelGatewayStatusConfig =
  | { enabled: false }
  | { enabled: true; profile: string; revision: string };

interface ModelGatewayRouteOptions {
  db: ModelGatewayStatusStore;
  config: ModelGatewayStatusConfig;
  now?: () => number;
  degradedLagMs?: number;
  awaitingGraceMs?: number;
}

const DEFAULT_DEGRADED_LAG_MS = 2 * 60_000;
// A completed gateway turn should be priced within one settlement cycle;
// past this age an unreconciled turn means a lost spend row or dead ingestion.
const DEFAULT_AWAITING_GRACE_MS = 15 * 60_000;
const DEFAULT_QUARANTINE_RECENT_MS = 24 * 60 * 60_000;
const DEFAULT_QUARANTINE_LIMIT = 20;
const MAX_QUARANTINE_LIMIT = 100;

export async function modelGatewayRoutes(
  app: FastifyInstance,
  opts: ModelGatewayRouteOptions,
): Promise<void> {
  app.get('/status', async () => {
    const now = (opts.now ?? Date.now)();
    const awaitingGraceMs = opts.awaitingGraceMs ?? DEFAULT_AWAITING_GRACE_MS;

    if (!opts.config.enabled) {
      // Ingestion being off is only benign while nothing waits on it. Any
      // gateway-attributed turn without reconciled usage means budgets and
      // analytics under-count — report degraded, not a quiet zero-state.
      const awaiting = await opts.db.getGatewayTurnsAwaitingReconciliation();
      return ModelGatewayStatusSchema.parse({
        enabled: false,
        profile: null,
        revision: null,
        state: awaiting.count > 0 ? 'degraded' : 'disabled',
        watermarkAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lagMs: null,
        lastError: awaiting.count > 0
          ? 'Spend ingestion is not configured, but completed gateway turns are awaiting prices'
          : null,
        pendingCalls: 0,
        unpricedCalls: 0,
        quarantinedTransactions: 0,
        orphanTransactions: 0,
        awaitingTurns: awaiting.count,
        oldestAwaitingAt: awaiting.oldestCompletedAt,
      });
    }

    const [reconciliation, metrics, awaiting] = await Promise.all([
      opts.db.getModelGatewayReconciliationState(opts.config.profile),
      opts.db.getModelGatewayReconciliationMetrics(opts.config.profile),
      opts.db.getGatewayTurnsAwaitingReconciliation(),
    ]);
    const watermarkAt = reconciliation?.watermarkMs
      ? reconciliation.watermarkMs
      : null;
    const lagMs = watermarkAt === null
      ? null
      : Math.max(0, now - watermarkAt);
    // A turn still unreconciled long after completion is a lost spend row:
    // the watermark keeps advancing, so lag alone never notices it.
    const staleAwaiting = awaiting.count > 0
      && awaiting.oldestCompletedAt !== null
      && now - awaiting.oldestCompletedAt > awaitingGraceMs;
    const state = !reconciliation?.lastSuccessAt
      ? reconciliation?.lastError
        ? 'degraded'
        : 'initializing'
      : reconciliation.lastError
        || lagMs === null
        || lagMs > (opts.degradedLagMs ?? DEFAULT_DEGRADED_LAG_MS)
        || staleAwaiting
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
      lastError: reconciliation?.lastError
        ?? (staleAwaiting
          ? 'Completed gateway turns have waited past the settlement grace period for prices'
          : null),
      ...metrics,
      awaitingTurns: awaiting.count,
      oldestAwaitingAt: awaiting.oldestCompletedAt,
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
