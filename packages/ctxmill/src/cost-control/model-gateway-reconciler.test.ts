import type { TurnUsage } from '@ctxmill/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ModelGatewayReconciler } from './model-gateway-reconciler.js';

const NOW = Date.UTC(2026, 6, 23, 12, 0, 0);
const PENDING_USAGE: TurnUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  modelCalls: { observed: 0, costKnown: 0, expected: null },
  cost: { totalUsd: null, knownUsd: 0, coverage: 'pending' },
};
const COMPLETE_USAGE: TurnUsage = {
  ...PENDING_USAGE,
  cost: { totalUsd: 0.02, knownUsd: 0.02, coverage: 'complete' },
};

function createDeps() {
  return {
    db: {
      claimModelGatewayReconciliationLease: vi.fn().mockResolvedValue({
        fenceToken: 7,
        watermarkMs: NOW - 60_000,
      }),
      recordModelGatewayReconciliationFailure: vi.fn().mockResolvedValue(true),
      reconcileModelGatewaySpend: vi.fn().mockResolvedValue({
        attached: 1,
        quarantined: 0,
        affectedTurnIds: ['turn-1'],
        usageChanges: [{
          turnId: 'turn-1',
          agentId: 'agent-1',
          previousUsage: PENDING_USAGE,
          usage: COMPLETE_USAGE,
        }],
        watermarkMs: NOW - 10_000,
      }),
    },
    spendClient: {
      listSpend: vi.fn().mockResolvedValue({
        records: [{
          transactionId: 'tx-1',
          correlationId: 'ct_0123456789abcdef0123456789abcdef',
          status: 'success',
          costState: 'priced',
          costUsd: 0.02,
          startedAt: NOW - 30_000,
          endedAt: NOW - 29_000,
        }],
        invalid: [],
      }),
    },
    onUsageReconciled: vi.fn().mockResolvedValue(undefined),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('ModelGatewayReconciler', () => {
  it('polls an overlap window, commits under the lease fence, and reports late usage', async () => {
    const deps = createDeps();
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      ownerId: 'worker-1',
      now: () => NOW,
      overlapMs: 30_000,
      settlementDelayMs: 10_000,
      leaseMs: 60_000,
    });

    await expect(reconciler.runOnce()).resolves.toEqual({
      status: 'success',
      attached: 1,
      quarantined: 0,
      affectedTurnIds: ['turn-1'],
      watermarkMs: NOW - 10_000,
    });
    expect(deps.spendClient.listSpend).toHaveBeenCalledWith({
      startMs: NOW - 90_000,
      endMs: NOW - 10_000,
    });
    expect(deps.db.reconcileModelGatewaySpend).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayProfile: 'default',
        gatewayRevision: 'dev1-r1',
        ownerId: 'worker-1',
        fenceToken: 7,
        processedThroughMs: NOW - 10_000,
        settleBeforeMs: NOW - 10_000,
      }),
    );
    expect(deps.onUsageReconciled).toHaveBeenCalledWith({
      turnId: 'turn-1',
      agentId: 'agent-1',
      previousUsage: PENDING_USAGE,
      usage: COMPLETE_USAGE,
    });
  });

  it('does no gateway I/O when another replica owns the lease', async () => {
    const deps = createDeps();
    deps.db.claimModelGatewayReconciliationLease.mockResolvedValue(undefined);
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      now: () => NOW,
    });

    await expect(reconciler.runOnce()).resolves.toEqual({
      status: 'not_owner',
    });
    expect(deps.spendClient.listSpend).not.toHaveBeenCalled();
    expect(deps.db.reconcileModelGatewaySpend).not.toHaveBeenCalled();
  });

  it('releases the claimed lease and preserves the watermark on spend API failure', async () => {
    const deps = createDeps();
    deps.spendClient.listSpend.mockRejectedValue(new Error('gateway unavailable'));
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      ownerId: 'worker-1',
      now: () => NOW,
    });

    await expect(reconciler.runOnce()).resolves.toEqual({
      status: 'failed',
      error: 'gateway unavailable',
    });
    expect(deps.db.recordModelGatewayReconciliationFailure).toHaveBeenCalledWith({
      gatewayProfile: 'default',
      ownerId: 'worker-1',
      fenceToken: 7,
      nowMs: NOW,
      error: 'gateway unavailable',
    });
    expect(deps.db.reconcileModelGatewaySpend).not.toHaveBeenCalled();
  });

  it('uses the bounded initial lookback when no watermark exists', async () => {
    const deps = createDeps();
    deps.db.claimModelGatewayReconciliationLease.mockResolvedValue({
      fenceToken: 1,
      watermarkMs: 0,
    });
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      now: () => NOW,
      initialLookbackMs: 300_000,
      settlementDelayMs: 10_000,
    });

    await reconciler.runOnce();
    expect(deps.spendClient.listSpend).toHaveBeenCalledWith({
      startMs: NOW - 310_000,
      endMs: NOW - 10_000,
    });
  });
});
