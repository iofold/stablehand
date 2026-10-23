import type { TurnUsage } from '@stablehand/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createIssuedGatewayKeys } from './issued-gateway-keys.js';
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
      extendModelGatewayReconciliationLease: vi.fn().mockResolvedValue(true),
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
        anomalies: [],
        watermarkMs: NOW - 10_000,
      }),
      settleAbandonedGatewayTurns: vi.fn().mockResolvedValue([]),
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
      campaignAttached: 0,
      settledUnpriced: 0,
      affectedTurnIds: ['turn-1'],
      watermarkMs: NOW - 10_000,
      truncated: false,
      skippedForeign: 0,
    });
    expect(deps.spendClient.listSpend).toHaveBeenCalledWith({
      startMs: NOW - 90_000,
      endMs: NOW - 10_000,
      signal: expect.any(AbortSignal),
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

  it('settles abandoned turns as unpriced past the grace and logs each loss', async () => {
    const deps = createDeps();
    deps.db.settleAbandonedGatewayTurns.mockResolvedValue([
      { turnId: 'turn-lost', correlationId: 'ct_deadbeefdeadbeefdeadbeefdeadbeef' },
    ]);
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      ownerId: 'worker-1',
      now: () => NOW,
      abandonedGraceMs: 10 * 60_000,
    });

    const result = await reconciler.runOnce();
    expect(result).toMatchObject({ status: 'success', settledUnpriced: 1 });
    expect(deps.db.settleAbandonedGatewayTurns).toHaveBeenCalledWith({
      nowMs: NOW,
      abandonedBeforeMs: NOW - 10 * 60_000,
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('turn-lost'),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('settled as unpriced'),
    );
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
      signal: expect.any(AbortSignal),
    });
  });

  it('backs off exponentially after failures and resumes after the gap', async () => {
    const deps = createDeps();
    deps.spendClient.listSpend.mockRejectedValue(new Error('gateway unavailable'));
    let nowMs = NOW;
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      ownerId: 'worker-1',
      now: () => nowMs,
      pollIntervalMs: 5_000,
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ status: 'failed' });
    // Immediately after a failure the next poll is skipped, not re-fetched.
    await expect(reconciler.runOnce()).resolves.toEqual({
      status: 'backed_off',
      retryAtMs: NOW + 10_000,
    });
    expect(deps.spendClient.listSpend).toHaveBeenCalledTimes(1);

    // Past the gap it retries; a success clears the backoff entirely.
    nowMs = NOW + 10_000;
    deps.spendClient.listSpend.mockResolvedValue({ records: [], invalid: [] });
    await expect(reconciler.runOnce()).resolves.toMatchObject({ status: 'success' });
    await expect(reconciler.runOnce()).resolves.toMatchObject({ status: 'success' });
  });

  it('commits partial progress when spend pagination truncates', async () => {
    const deps = createDeps();
    deps.spendClient.listSpend.mockResolvedValue({
      records: [],
      invalid: [],
      truncatedAtMs: NOW - 40_000,
    });
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      ownerId: 'worker-1',
      now: () => NOW,
      settlementDelayMs: 10_000,
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({
      status: 'success',
      truncated: true,
    });
    // Watermark and settlement stop at the fetch boundary, not the window end.
    expect(deps.db.reconcileModelGatewaySpend).toHaveBeenCalledWith(
      expect.objectContaining({
        processedThroughMs: NOW - 40_000,
        settleBeforeMs: NOW - 40_000,
      }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('partial progress'),
    );
  });

  it('never moves the effective boundary behind the claimed watermark', async () => {
    const deps = createDeps();
    deps.db.claimModelGatewayReconciliationLease.mockResolvedValue({
      fenceToken: 7,
      watermarkMs: NOW - 20_000,
    });
    deps.spendClient.listSpend.mockResolvedValue({
      records: [],
      invalid: [],
      truncatedAtMs: NOW - 300_000,
    });
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      ownerId: 'worker-1',
      now: () => NOW,
    });

    await reconciler.runOnce();
    expect(deps.db.reconcileModelGatewaySpend).toHaveBeenCalledWith(
      expect.objectContaining({ processedThroughMs: NOW - 20_000 }),
    );
  });

  it('logs turns skipped as anomalies instead of failing the run', async () => {
    const deps = createDeps();
    deps.db.reconcileModelGatewaySpend.mockResolvedValue({
      attached: 0,
      quarantined: 0,
      affectedTurnIds: [],
      usageChanges: [],
      anomalies: [{ turnId: 'turn-odd', reason: 'lost_attribution_row' }],
      watermarkMs: NOW - 10_000,
    });
    const reconciler = new ModelGatewayReconciler(deps, {
      profile: 'default',
      revision: 'dev1-r1',
      now: () => NOW,
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({ status: 'success' });
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('turn-odd'),
    );
  });

  it('aborts a run whose lease heartbeat reports the lease lost', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps();
      deps.db.extendModelGatewayReconciliationLease.mockResolvedValue(false);
      deps.spendClient.listSpend.mockImplementation(
        ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
      );
      const reconciler = new ModelGatewayReconciler(deps, {
        profile: 'default',
        revision: 'dev1-r1',
        ownerId: 'worker-1',
        now: () => NOW,
        leaseMs: 60_000,
        heartbeatMs: 20_000,
      });

      const run = reconciler.runOnce();
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(run).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('lease lost'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a spend fetch that outlives the lease duration', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps();
      deps.spendClient.listSpend.mockImplementation(
        ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
      );
      const reconciler = new ModelGatewayReconciler(deps, {
        profile: 'default',
        revision: 'dev1-r1',
        ownerId: 'worker-1',
        now: () => NOW,
        leaseMs: 60_000,
        heartbeatMs: 20_000,
      });

      const run = reconciler.runOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(run).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('exceeded'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits campaign-key spend and hands the spend change to the budget alerts (ctx-hmm3)', async () => {
    const deps = createDeps();
    const campaignRecord = {
      transactionId: 'tx-campaign',
      campaignKeyId: 'gck_1',
      status: 'success',
      costState: 'priced',
      costUsd: 0.4,
      totalTokens: 100,
      startedAt: NOW - 30_000,
      endedAt: NOW - 29_000,
    };
    const change = {
      campaignKeyId: 'gck_1',
      tags: { campaign: 'bugfarm' },
      notifyAgentId: null,
      costUsdDelta: 0.4,
      totalTokensDelta: 100,
    };
    deps.spendClient.listSpend.mockResolvedValue({
      records: [],
      campaignRecords: [campaignRecord],
      invalid: [],
      skippedForeign: 0,
    });
    deps.db.reconcileModelGatewaySpend.mockResolvedValue({
      attached: 0,
      quarantined: 0,
      campaignAttached: 1,
      campaignChanges: [change],
      affectedTurnIds: [],
      usageChanges: [],
      anomalies: [],
      watermarkMs: NOW - 10_000,
    });
    const onCampaignSpendReconciled = vi.fn().mockResolvedValue(undefined);
    const reconciler = new ModelGatewayReconciler({ ...deps, onCampaignSpendReconciled }, {
      profile: 'default',
      revision: 'dev1-r1',
      ownerId: 'worker-1',
      now: () => NOW,
    });

    await expect(reconciler.runOnce()).resolves.toMatchObject({
      status: 'success',
      campaignAttached: 1,
    });
    expect(deps.db.reconcileModelGatewaySpend).toHaveBeenCalledWith(
      expect.objectContaining({ campaignRecords: [campaignRecord] }),
    );
    expect(onCampaignSpendReconciled).toHaveBeenCalledWith([change]);
  });

  describe('keys Stablehand did not issue (ctx-gfp8)', () => {
    it('reads only issued keys and reports foreign rows as skipped, never committed', async () => {
      const deps = createDeps();
      const issuedKeys = createIssuedGatewayKeys({ runtimeKey: 'sk-runtime' });
      deps.spendClient.listSpend.mockResolvedValue({
        records: [],
        campaignRecords: [],
        invalid: [],
        skippedForeign: 3,
      });
      const reconciler = new ModelGatewayReconciler({
        ...deps,
        resolveIssuedKeys: async () => issuedKeys,
      }, {
        profile: 'default',
        revision: 'dev1-r1',
        ownerId: 'worker-1',
        now: () => NOW,
      });

      await expect(reconciler.runOnce()).resolves.toMatchObject({
        status: 'success',
        skippedForeign: 3,
      });
      expect(deps.spendClient.listSpend).toHaveBeenCalledWith(
        expect.objectContaining({ issuedKeys }),
      );
      expect(deps.db.reconcileModelGatewaySpend).toHaveBeenCalledWith(
        expect.objectContaining({ records: [], invalid: [] }),
      );
    });

    it('logs the skipped count at most once per interval', async () => {
      const deps = createDeps();
      let nowMs = NOW;
      deps.spendClient.listSpend.mockResolvedValue({
        records: [],
        campaignRecords: [],
        invalid: [],
        skippedForeign: 2,
      });
      const reconciler = new ModelGatewayReconciler({
        ...deps,
        resolveIssuedKeys: async () => createIssuedGatewayKeys({ runtimeKey: 'sk-runtime' }),
      }, {
        profile: 'default',
        revision: 'dev1-r1',
        ownerId: 'worker-1',
        now: () => nowMs,
      });
      const skipLines = () => deps.logger.info.mock.calls
        .filter(([line]) => String(line).includes('did not issue'));

      await reconciler.runOnce();
      expect(skipLines()).toHaveLength(1);
      expect(String(skipLines()[0]?.[0])).toContain('skipped 2 spend row(s)');

      nowMs = NOW + 5_000;
      await reconciler.runOnce();
      expect(skipLines()).toHaveLength(1);

      nowMs = NOW + 11 * 60_000;
      await reconciler.runOnce();
      expect(skipLines()).toHaveLength(2);
      // The second line carries everything skipped since the first.
      expect(String(skipLines()[1]?.[0])).toContain('skipped 4 spend row(s)');
    });
  });
});
