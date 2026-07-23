import type { FastifyInstance } from 'fastify';
import { ModelGatewayStatusSchema } from '@ctxmill/contracts';

import type { DatabaseRepository } from '../../database/repository.js';

type ModelGatewayStatusStore = Pick<
  DatabaseRepository,
  | 'getModelGatewayReconciliationState'
  | 'getModelGatewayReconciliationMetrics'
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
}
