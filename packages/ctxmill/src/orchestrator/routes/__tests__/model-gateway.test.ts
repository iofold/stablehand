import Fastify from 'fastify';
import { ModelGatewayStatusSchema } from '@ctxmill/contracts';
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
