import Fastify from 'fastify';
import {
  ModelGatewayQuarantineSchema,
  ModelGatewayStatusSchema,
} from '@ctxmill/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { modelGatewayRoutes } from '../model-gateway.js';

describe('model gateway status route', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns disabled without touching gateway persistence', async () => {
    const db = {
      getModelGatewayReconciliationState: vi.fn(),
      getModelGatewayReconciliationMetrics: vi.fn(),
      getModelGatewayQuarantineSummary: vi.fn(),
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(modelGatewayRoutes, {
      prefix: '/api/model-gateway',
      db,
      config: { enabled: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/model-gateway/status',
    });
    expect(ModelGatewayStatusSchema.parse(response.json())).toMatchObject({
      enabled: false,
      state: 'disabled',
    });
    expect(db.getModelGatewayReconciliationState).not.toHaveBeenCalled();
  });

  it('serves a reason-grouped quarantine breakdown with recency', async () => {
    const db = {
      getModelGatewayReconciliationState: vi.fn(),
      getModelGatewayReconciliationMetrics: vi.fn(),
      getModelGatewayQuarantineSummary: vi.fn().mockResolvedValue({
        reasons: [
          {
            reason: 'missing_correlation',
            total: 28,
            recentTotal: 2,
            lastSeenAt: 190_000,
          },
          {
            reason: 'unknown_turn',
            total: 1,
            recentTotal: 0,
            lastSeenAt: 90_000,
          },
        ],
        recent: [{
          transactionId: 'txn-1',
          correlationId: null,
          reason: 'missing_correlation',
          occurrences: 3,
          firstSeenAt: 100_000,
          lastSeenAt: 190_000,
          sanitizedPayload: { model: 'gpt-5.4-mini', status: 'success' },
        }],
      }),
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(modelGatewayRoutes, {
      prefix: '/api/model-gateway',
      db,
      config: { enabled: true, profile: 'default', revision: 'dev1-r1' },
      now: () => 200_000_000,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/model-gateway/quarantine',
    });
    expect(ModelGatewayQuarantineSchema.parse(response.json())).toMatchObject({
      enabled: true,
      profile: 'default',
      recentSince: 200_000_000 - 24 * 60 * 60_000,
      total: 29,
      recentTotal: 2,
      reasons: [
        expect.objectContaining({ reason: 'missing_correlation', total: 28 }),
        expect.objectContaining({ reason: 'unknown_turn', total: 1 }),
      ],
    });
    expect(db.getModelGatewayQuarantineSummary).toHaveBeenCalledWith(
      'default',
      { recentSinceMs: 200_000_000 - 24 * 60 * 60_000, limit: 20 },
    );

    const custom = await app.inject({
      method: 'GET',
      url: '/api/model-gateway/quarantine?since=150000&limit=5',
    });
    expect(custom.statusCode).toBe(200);
    expect(db.getModelGatewayQuarantineSummary).toHaveBeenLastCalledWith(
      'default',
      { recentSinceMs: 150_000, limit: 5 },
    );

    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/model-gateway/quarantine?limit=0',
    });
    expect(badLimit.statusCode).toBe(400);
    const badSince = await app.inject({
      method: 'GET',
      url: '/api/model-gateway/quarantine?since=nope',
    });
    expect(badSince.statusCode).toBe(400);
  });

  it('returns a disabled quarantine envelope without touching persistence', async () => {
    const db = {
      getModelGatewayReconciliationState: vi.fn(),
      getModelGatewayReconciliationMetrics: vi.fn(),
      getModelGatewayQuarantineSummary: vi.fn(),
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(modelGatewayRoutes, {
      prefix: '/api/model-gateway',
      db,
      config: { enabled: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/model-gateway/quarantine',
    });
    expect(ModelGatewayQuarantineSchema.parse(response.json())).toMatchObject({
      enabled: false,
      profile: null,
      total: 0,
    });
    expect(db.getModelGatewayQuarantineSummary).not.toHaveBeenCalled();
  });

  it('projects reconciliation lag and sanitized degraded counters', async () => {
    const db = {
      getModelGatewayReconciliationState: vi.fn().mockResolvedValue({
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        watermarkMs: 1_000,
        lastAttemptAt: 1_100,
        lastSuccessAt: 1_050,
        lastError: null,
      }),
      getModelGatewayReconciliationMetrics: vi.fn().mockResolvedValue({
        pendingCalls: 2,
        unpricedCalls: 1,
        quarantinedTransactions: 3,
        orphanTransactions: 1,
      }),
      getModelGatewayQuarantineSummary: vi.fn(),
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(modelGatewayRoutes, {
      prefix: '/api/model-gateway',
      db,
      config: {
        enabled: true,
        profile: 'default',
        revision: 'dev1-r1',
      },
      now: () => 200_000,
      degradedLagMs: 10_000,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/model-gateway/status',
    });
    expect(ModelGatewayStatusSchema.parse(response.json())).toEqual({
      enabled: true,
      profile: 'default',
      revision: 'dev1-r1',
      state: 'degraded',
      watermarkAt: 1_000,
      lastAttemptAt: 1_100,
      lastSuccessAt: 1_050,
      lagMs: 199_000,
      lastError: null,
      pendingCalls: 2,
      unpricedCalls: 1,
      quarantinedTransactions: 3,
      orphanTransactions: 1,
    });
  });
});
