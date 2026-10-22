import { describe, expect, it, vi } from 'vitest';

import {
  SessionGatewayKeyManager,
  budgetStopReason,
  readRunSpendCapUsd,
  sessionKeyAlias,
} from './session-gateway-keys.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeClient(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    generateKey: vi.fn().mockResolvedValue({ key: 'sk-session-secret', tokenHash: 'hash-s1' }),
    updateKey: vi.fn().mockResolvedValue(undefined),
    deleteKeysByAlias: vi.fn().mockResolvedValue(undefined),
    getKeyModels: vi.fn().mockResolvedValue(['gpt-5.4-mini', 'claude-haiku-4-5']),
    findKeyHashByAlias: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeManager(options: {
  client?: ReturnType<typeof makeClient>;
  headroom?: Awaited<ReturnType<NonNullable<ConstructorParameters<typeof SessionGatewayKeyManager>[0]['resolvePolicyHeadroom']>>>;
  tags?: Record<string, string>;
} = {}) {
  const client = options.client ?? makeClient();
  const resolvePolicyHeadroom = vi.fn().mockResolvedValue(options.headroom ?? null);
  const getTurnTags = vi.fn().mockResolvedValue(options.tags ?? { team: 'growth' });
  const manager = new SessionGatewayKeyManager({
    client,
    runtimeKey: 'sk-shared-runtime',
    getTurnTags,
    resolvePolicyHeadroom,
    logger: silentLogger,
  });
  return { manager, client, resolvePolicyHeadroom, getTurnTags };
}

describe('readRunSpendCapUsd', () => {
  it('reads harnessConfig.limits.maxCostUsd and ignores anything else', () => {
    expect(readRunSpendCapUsd({ model: 'm', limits: { maxCostUsd: 0.05 } })).toBe(0.05);
    expect(readRunSpendCapUsd({ limits: { maxModelCalls: 5 } })).toBeNull();
    expect(readRunSpendCapUsd({ limits: { maxCostUsd: 0 } })).toBeNull();
    expect(readRunSpendCapUsd({ limits: 'nope' })).toBeNull();
    expect(readRunSpendCapUsd(undefined)).toBeNull();
  });
});

describe('SessionGatewayKeyManager', () => {
  it('mints a session key with the runtime key model scope after clearing a stale alias', async () => {
    const { manager, client } = makeManager();

    await expect(manager.mintSessionKey({ sessionId: 's1', agentId: 'agent-1' })).resolves.toBe('sk-session-secret');

    expect(client.getKeyModels).toHaveBeenCalledWith('sk-shared-runtime');
    expect(client.deleteKeysByAlias).toHaveBeenCalledWith(['stablehand-session-s1']);
    expect(client.deleteKeysByAlias.mock.invocationCallOrder[0]).toBeLessThan(
      client.generateKey.mock.invocationCallOrder[0]!,
    );
    expect(client.generateKey).toHaveBeenCalledWith({
      keyAlias: 'stablehand-session-s1',
      models: ['gpt-5.4-mini', 'claude-haiku-4-5'],
      maxBudgetUsd: null,
      duration: '24h',
      metadata: { stablehand_session_id: 's1', stablehand_agent_id: 'agent-1' },
    });
  });

  it('caches the inherited model scope across sessions', async () => {
    const { manager, client } = makeManager();
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });
    await manager.mintSessionKey({ sessionId: 's2', agentId: 'a' });
    expect(client.getKeyModels).toHaveBeenCalledTimes(1);
  });

  it('falls back to the shared key when minting fails, and then skips capping that session', async () => {
    const client = makeClient({ generateKey: vi.fn().mockRejectedValue(new Error('litellm down')) });
    const { manager } = makeManager({ client });

    await expect(manager.mintSessionKey({ sessionId: 's1', agentId: 'a' })).resolves.toBeNull();
    await expect(manager.prepareTurn({
      sessionId: 's1',
      turnId: 't1',
      harnessConfig: { limits: { maxCostUsd: 1 } },
    })).resolves.toBeNull();
    expect(client.updateKey).not.toHaveBeenCalled();
    expect(client.findKeyHashByAlias).not.toHaveBeenCalled();
  });

  it('does not widen the model scope when the runtime key cannot be read', async () => {
    const client = makeClient({ getKeyModels: vi.fn().mockRejectedValue(new Error('403')) });
    const { manager } = makeManager({ client });

    await expect(manager.mintSessionKey({ sessionId: 's1', agentId: 'a' })).resolves.toBeNull();
    expect(client.generateKey).not.toHaveBeenCalled();
  });

  it('arms the per-run limit on the session key and resets its spend', async () => {
    const { manager, client } = makeManager();
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });

    const cap = await manager.prepareTurn({
      sessionId: 's1',
      turnId: 't1',
      harnessConfig: { limits: { maxCostUsd: 0.05 } },
    });

    expect(cap).toEqual({ capUsd: 0.05, source: 'run_limit' });
    expect(client.updateKey).toHaveBeenCalledWith({
      key: 'hash-s1',
      maxBudgetUsd: 0.05,
      resetSpend: true,
      duration: '24h',
    });
    expect(manager.capForTurn('t1')).toEqual(cap);
  });

  it('uses the remaining policy headroom when it is tighter than the run limit', async () => {
    const { manager, client, resolvePolicyHeadroom } = makeManager({
      headroom: {
        remainingUsd: 0.02,
        limitUsd: 10,
        spentUsd: 9.98,
        policyId: 'p1',
        policyName: 'Growth team',
        bucket: 'team=growth',
      },
    });
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });

    const cap = await manager.prepareTurn({
      sessionId: 's1',
      turnId: 't1',
      harnessConfig: { limits: { maxCostUsd: 0.05 } },
    });

    expect(resolvePolicyHeadroom).toHaveBeenCalledWith({ team: 'growth' });
    expect(cap).toEqual({
      capUsd: 0.02,
      source: 'budget_policy',
      policyId: 'p1',
      policyName: 'Growth team',
      bucket: 'team=growth',
    });
    expect(client.updateKey).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 0.02 }));
  });

  it('clears the budget when no cap applies', async () => {
    const { manager, client } = makeManager();
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });

    await expect(manager.prepareTurn({ sessionId: 's1', turnId: 't1', harnessConfig: {} })).resolves.toBeNull();
    expect(client.updateKey).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: null, resetSpend: true }));
  });

  it('keeps cap and spend for a continuation of a paused run', async () => {
    const { manager, client } = makeManager();
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });
    await manager.prepareTurn({ sessionId: 's1', turnId: 't1', harnessConfig: { limits: { maxCostUsd: 0.5 } } });

    const cap = await manager.prepareTurn({
      sessionId: 's1',
      turnId: 't1',
      harnessConfig: { limits: { maxCostUsd: 0.5 } },
      continuation: true,
    });

    expect(cap).toEqual({ capUsd: 0.5, source: 'run_limit' });
    expect(client.updateKey).toHaveBeenCalledTimes(1);
  });

  it('finds the key of a session opened before an orchestrator restart', async () => {
    const client = makeClient({ findKeyHashByAlias: vi.fn().mockResolvedValue('hash-old') });
    const { manager } = makeManager({ client });

    await manager.prepareTurn({ sessionId: 'old', turnId: 't1', harnessConfig: { limits: { maxCostUsd: 1 } } });
    await manager.prepareTurn({ sessionId: 'old', turnId: 't2', harnessConfig: { limits: { maxCostUsd: 1 } } });

    expect(client.findKeyHashByAlias).toHaveBeenCalledTimes(1);
    expect(client.findKeyHashByAlias).toHaveBeenCalledWith('stablehand-session-old');
    expect(client.updateKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'hash-old' }));
  });

  it('records no cap when the gateway rejects the update, so a refusal is not misattributed', async () => {
    const client = makeClient({ updateKey: vi.fn().mockRejectedValue(new Error('timeout')) });
    const { manager } = makeManager({ client });
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });

    await expect(manager.prepareTurn({
      sessionId: 's1',
      turnId: 't1',
      harnessConfig: { limits: { maxCostUsd: 1 } },
    })).resolves.toBeNull();
    expect(manager.capForTurn('t1')).toBeNull();
  });

  it('revokes by alias, forgets the session, and never throws', async () => {
    const client = makeClient();
    const { manager } = makeManager({ client });
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });
    await manager.prepareTurn({ sessionId: 's1', turnId: 't1', harnessConfig: { limits: { maxCostUsd: 1 } } });

    await manager.revokeSessionKey('s1');
    expect(client.deleteKeysByAlias).toHaveBeenLastCalledWith([sessionKeyAlias('s1')]);
    expect(manager.capForTurn('t1')).toBeNull();

    client.deleteKeysByAlias.mockRejectedValueOnce(new Error('litellm down'));
    await expect(manager.revokeSessionKey('s1')).resolves.toBeUndefined();
  });

  it('settles a finished run', async () => {
    const { manager } = makeManager();
    await manager.mintSessionKey({ sessionId: 's1', agentId: 'a' });
    await manager.prepareTurn({ sessionId: 's1', turnId: 't1', harnessConfig: { limits: { maxCostUsd: 1 } } });

    manager.settleTurn('t1');
    expect(manager.capForTurn('t1')).toBeNull();
  });
});

describe('budgetStopReason', () => {
  it('reports budget_reached against the cap Stablehand set for the run', () => {
    expect(budgetStopReason(
      { capUsd: 0.05, source: 'run_limit' },
      { spentUsd: 0.0512, capUsd: 0.05 },
    )).toEqual({ code: 'budget_reached', source: 'run_limit', capUsd: 0.05, spentUsd: 0.0512 });

    expect(budgetStopReason(
      { capUsd: 2, source: 'budget_policy', policyId: 'p1', policyName: 'Growth team', bucket: 'team=growth' },
      { spentUsd: null, capUsd: 2 },
    )).toEqual({
      code: 'budget_reached',
      source: 'budget_policy',
      capUsd: 2,
      spentUsd: null,
      policyId: 'p1',
      policyName: 'Growth team',
      bucket: 'team=growth',
    });
  });

  it('reports a refusal under no Stablehand cap as the gateway ceiling', () => {
    expect(budgetStopReason(null, { spentUsd: 100.2, capUsd: 100 })).toEqual({
      code: 'model_gateway_budget_exceeded',
      spentUsd: 100.2,
      limitUsd: 100,
    });
  });
});
