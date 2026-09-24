import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AnalyticsOverviewQuerySchema,
  AnalyticsOverviewSchema,
  type AnalyticsMetrics,
  type AnalyticsWindow,
} from '@stablehand/contracts';

import type { DatabaseRepository } from '../../database/repository.js';
import { parseStoredHarnessConfig } from '../agent-definition.js';

export interface AnalyticsRouteOptions {
  db: Pick<DatabaseRepository, 'getAnalyticsSnapshot'>;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOWS: Record<AnalyticsWindow, {
  durationMs: number;
  bucketSizeMs: number;
}> = {
  '24h': { durationMs: DAY_MS, bucketSizeMs: HOUR_MS },
  '7d': { durationMs: 7 * DAY_MS, bucketSizeMs: DAY_MS },
  '30d': { durationMs: 30 * DAY_MS, bucketSizeMs: DAY_MS },
};

function emptyMetrics(): AnalyticsMetrics {
  return {
    turns: 0,
    completedTurns: 0,
    errorTurns: 0,
    cancelledTurns: 0,
    activeTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenReportedTurns: 0,
    knownCostUsd: 0,
    costCoverage: {
      complete: 0,
      partial: 0,
      pending: 0,
      unpriced: 0,
    },
  };
}

function addMetrics(total: AnalyticsMetrics, metrics: AnalyticsMetrics): AnalyticsMetrics {
  return {
    turns: total.turns + metrics.turns,
    completedTurns: total.completedTurns + metrics.completedTurns,
    errorTurns: total.errorTurns + metrics.errorTurns,
    cancelledTurns: total.cancelledTurns + metrics.cancelledTurns,
    activeTurns: total.activeTurns + metrics.activeTurns,
    inputTokens: total.inputTokens + metrics.inputTokens,
    outputTokens: total.outputTokens + metrics.outputTokens,
    totalTokens: total.totalTokens + metrics.totalTokens,
    tokenReportedTurns: total.tokenReportedTurns + metrics.tokenReportedTurns,
    knownCostUsd: total.knownCostUsd + metrics.knownCostUsd,
    costCoverage: {
      complete: total.costCoverage.complete + metrics.costCoverage.complete,
      partial: total.costCoverage.partial + metrics.costCoverage.partial,
      pending: total.costCoverage.pending + metrics.costCoverage.pending,
      unpriced: total.costCoverage.unpriced + metrics.costCoverage.unpriced,
    },
  };
}

function modelFromHarnessConfig(harnessConfig: string): string | null {
  const model = parseStoredHarnessConfig(harnessConfig).model;
  return typeof model === 'string' && model.trim() ? model : null;
}

export async function analyticsRoutes(
  app: FastifyInstance,
  opts: AnalyticsRouteOptions,
): Promise<void> {
  app.get('/overview', async (
    request: FastifyRequest<{ Querystring: unknown }>,
    reply,
  ) => {
    const query = AnalyticsOverviewQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.status(400).send({ error: 'Invalid analytics window' });
    }

    const now = opts.now?.() ?? Date.now();
    const windowConfig = WINDOWS[query.data.window];
    const from = now - windowConfig.durationMs;
    const snapshot = await opts.db.getAnalyticsSnapshot({
      from,
      to: now,
      bucketSizeMs: windowConfig.bucketSizeMs,
    });
    const totals = snapshot.agents.reduce<AnalyticsMetrics>(
      addMetrics,
      emptyMetrics(),
    );

    return AnalyticsOverviewSchema.parse({
      window: query.data.window,
      from,
      to: now,
      bucketSizeMs: windowConfig.bucketSizeMs,
      totals: {
        agents: snapshot.agents.length,
        activeAgents: snapshot.agents.filter((agent) => agent.turns > 0).length,
        ...totals,
      },
      activity: snapshot.activity,
      agents: snapshot.agents.map(({ harnessConfig, ...agent }) => ({
        ...agent,
        model: modelFromHarnessConfig(harnessConfig),
      })),
    });
  });
}
