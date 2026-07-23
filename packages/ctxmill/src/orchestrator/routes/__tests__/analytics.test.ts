import Fastify from 'fastify';
import { AnalyticsOverviewSchema } from '@ctxmill/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { analyticsRoutes } from '../analytics.js';

const EMPTY_COVERAGE = {
  complete: 0,
  partial: 0,
  pending: 0,
  unpriced: 0,
} as const;

describe('analytics overview route', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns a canonical bounded overview and derives totals and model names', async () => {
    const now = 1_800_000_000_000;
    const db = {
      getAnalyticsSnapshot: vi.fn().mockResolvedValue({
        activity: [{
          from: now - 60 * 60 * 1000,
          to: now,
          turns: 2,
          completedTurns: 1,
          errorTurns: 1,
          cancelledTurns: 0,
          activeTurns: 0,
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          tokenReportedTurns: 1,
          knownCostUsd: 0.012,
          costCoverage: {
            complete: 1,
            partial: 0,
            pending: 1,
            unpriced: 0,
          },
        }],
        agents: [{
          agentId: 'agent-1',
          name: 'Close analyst',
          harness: 'langgraph',
          harnessConfig: JSON.stringify({ model: 'gpt-5.4-mini' }),
          lastActivityAt: now - 100,
          turns: 2,
          completedTurns: 1,
          errorTurns: 1,
          cancelledTurns: 0,
          activeTurns: 0,
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          tokenReportedTurns: 1,
          knownCostUsd: 0.012,
          costCoverage: {
            complete: 1,
            partial: 0,
            pending: 1,
            unpriced: 0,
          },
        }, {
          agentId: 'agent-2',
          name: 'Idle analyst',
          harness: 'claude-agents',
          harnessConfig: JSON.stringify({ model: 'claude-haiku-4-5' }),
          lastActivityAt: null,
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
          costCoverage: EMPTY_COVERAGE,
        }],
      }),
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(analyticsRoutes, {
      prefix: '/api/analytics',
      db,
      now: () => now,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/analytics/overview',
    });
    expect(response.statusCode).toBe(200);
    expect(AnalyticsOverviewSchema.parse(response.json())).toMatchObject({
      window: '24h',
      from: now - 24 * 60 * 60 * 1000,
      to: now,
      bucketSizeMs: 60 * 60 * 1000,
      totals: {
        agents: 2,
        activeAgents: 1,
        turns: 2,
        totalTokens: 100,
        knownCostUsd: 0.012,
      },
      agents: [{
        agentId: 'agent-1',
        model: 'gpt-5.4-mini',
      }, {
        agentId: 'agent-2',
        model: 'claude-haiku-4-5',
      }],
    });
    expect(db.getAnalyticsSnapshot).toHaveBeenCalledWith({
      from: now - 24 * 60 * 60 * 1000,
      to: now,
      bucketSizeMs: 60 * 60 * 1000,
    });
  });

  it('rejects unknown windows without querying persistence', async () => {
    const db = {
      getAnalyticsSnapshot: vi.fn(),
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(analyticsRoutes, {
      prefix: '/api/analytics',
      db,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/analytics/overview?window=quarter',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid analytics window',
    });
    expect(db.getAnalyticsSnapshot).not.toHaveBeenCalled();
  });
});
