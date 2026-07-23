import { describe, expect, it } from 'vitest';

import { ModelGatewayStatusSchema } from './model-gateway.js';

describe('ModelGatewayStatusSchema', () => {
  it('distinguishes a disabled deployment from an enabled degraded meter', () => {
    expect(ModelGatewayStatusSchema.parse({
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
    }).state).toBe('disabled');

    expect(ModelGatewayStatusSchema.parse({
      enabled: true,
      profile: 'default',
      revision: 'dev1-r1',
      state: 'degraded',
      watermarkAt: 100,
      lastAttemptAt: 200,
      lastSuccessAt: 100,
      lagMs: 150,
      lastError: 'spend endpoint returned HTTP 503',
      pendingCalls: 2,
      unpricedCalls: 1,
      quarantinedTransactions: 3,
      orphanTransactions: 1,
    }).enabled).toBe(true);
  });

  it('rejects hidden credential fields and negative counters', () => {
    expect(() => ModelGatewayStatusSchema.parse({
      enabled: false,
      profile: null,
      revision: null,
      state: 'disabled',
      watermarkAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lagMs: null,
      lastError: null,
      pendingCalls: -1,
      unpricedCalls: 0,
      quarantinedTransactions: 0,
      orphanTransactions: 0,
      runtimeKey: 'secret',
    })).toThrow();
  });
});
