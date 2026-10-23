import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { ModelGatewayCampaignKeyRow } from '../database/types.js';
import {
  CampaignGatewayKeyService,
  CampaignKeyError,
  DEFAULT_CAMPAIGN_KEY_LIFETIME_MS,
  campaignKeyStatus,
} from './campaign-gateway-keys.js';
import { LiteLLMKeyAdminError } from './litellm-key-client.js';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const SECRET = 'sk-campaign-secret';
const SECRET_HASH = createHash('sha256').update(SECRET).digest('hex');

function createDeps(overrides: {
  runtimeModels?: string[];
  headroom?: { remainingUsd: number; limitUsd?: number; spentUsd?: number } | null;
} = {}) {
  const rows = new Map<string, ModelGatewayCampaignKeyRow>();
  const client = {
    getKeyModels: vi.fn().mockResolvedValue(overrides.runtimeModels ?? ['gpt-5.4-mini', 'claude-sonnet-5']),
    generateKey: vi.fn().mockResolvedValue({ key: SECRET, tokenHash: SECRET_HASH }),
    deleteKeysByAlias: vi.fn().mockResolvedValue(undefined),
  };
  const db = {
    createModelGatewayCampaignKey: vi.fn(async (data: Record<string, unknown>) => {
      const row = {
        requestedMaxBudgetUsd: null,
        maxBudgetUsd: null,
        capSource: null,
        capPolicyId: null,
        capPolicyName: null,
        notifyAgentId: null,
        createdBy: null,
        expiresAt: null,
        revokedAt: null,
        ...data,
      } as ModelGatewayCampaignKeyRow;
      rows.set(row.id, row);
      return row;
    }),
    getModelGatewayCampaignKey: vi.fn(async (id: string) => rows.get(id)),
    markModelGatewayCampaignKeyRevoked: vi.fn(async (id: string, revokedAt: number) => {
      const row = rows.get(id);
      if (!row) return undefined;
      const updated = { ...row, revokedAt: row.revokedAt ?? revokedAt };
      rows.set(id, updated);
      return updated;
    }),
    getModelGatewayCampaignKeySpend: vi.fn().mockResolvedValue(new Map()),
    getAgent: vi.fn(async (id: string) => (id === 'agent-1' ? { id } : undefined)),
  };
  const headroom = overrides.headroom === undefined
    ? null
    : overrides.headroom && {
      remainingUsd: overrides.headroom.remainingUsd,
      limitUsd: overrides.headroom.limitUsd ?? 500,
      spentUsd: overrides.headroom.spentUsd ?? 500 - overrides.headroom.remainingUsd,
      policyId: 'policy-1',
      policyName: 'Bugfarm November',
    };
  const resolvePolicyHeadroom = vi.fn().mockResolvedValue(headroom);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new CampaignGatewayKeyService({
    client,
    runtimeKey: 'sk-runtime',
    db: db as never,
    resolvePolicyHeadroom,
    logger,
    now: () => NOW,
  });
  return { service, client, db, rows, resolvePolicyHeadroom, logger };
}

const INPUT = {
  name: 'terminus calibration',
  tags: { campaign: 'bugfarm-2026-11' },
  models: ['gpt-5.4-mini'],
};

describe('CampaignGatewayKeyService.create', () => {
  it('mints a capped key, stores only its hash, and returns the secret once', async () => {
    const { service, client, db, resolvePolicyHeadroom } = createDeps({ headroom: { remainingUsd: 300 } });

    const created = await service.create({ ...INPUT, maxBudgetUsd: 120 }, 'master');

    expect(resolvePolicyHeadroom).toHaveBeenCalledWith({ campaign: 'bugfarm-2026-11' });
    expect(client.generateKey).toHaveBeenCalledWith({
      keyAlias: `stablehand-campaign-${created.id}`,
      models: ['gpt-5.4-mini'],
      maxBudgetUsd: 120,
      duration: `${DEFAULT_CAMPAIGN_KEY_LIFETIME_MS / 1000}s`,
      metadata: { stablehand_campaign_key_id: created.id },
    });
    expect(created.id).toMatch(/^gck_/);
    expect(created.key).toBe(SECRET);
    expect(created).toMatchObject({
      status: 'active',
      maxBudgetUsd: 120,
      requestedMaxBudgetUsd: 120,
      capSource: 'request',
      capPolicyId: null,
      expiresAt: NOW + DEFAULT_CAMPAIGN_KEY_LIFETIME_MS,
      createdBy: 'master',
      spend: { costUsd: 0, calls: 0 },
    });
    const stored = db.createModelGatewayCampaignKey.mock.calls[0]?.[0];
    expect(stored).toMatchObject({ keyHash: SECRET_HASH, tags: { campaign: 'bugfarm-2026-11' } });
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it('caps the key at the matching policy\'s remaining headroom when that is lower', async () => {
    const { service, client } = createDeps({ headroom: { remainingUsd: 75 } });

    const created = await service.create({ ...INPUT, maxBudgetUsd: 200 }, 'master');

    expect(client.generateKey).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 75 }));
    expect(created).toMatchObject({
      maxBudgetUsd: 75,
      requestedMaxBudgetUsd: 200,
      capSource: 'budget_policy',
      capPolicyId: 'policy-1',
      capPolicyName: 'Bugfarm November',
    });
  });

  it('mints without a cap when neither a budget nor a policy applies', async () => {
    const { service, client } = createDeps();

    const created = await service.create({ ...INPUT, expiresAt: NOW + 3_600_000 }, 'master');

    expect(client.generateKey).toHaveBeenCalledWith(expect.objectContaining({
      maxBudgetUsd: null,
      duration: '3600s',
    }));
    expect(created).toMatchObject({ maxBudgetUsd: null, capSource: null });
  });

  it('refuses models the runtime key does not allow, before minting', async () => {
    const { service, client } = createDeps({ runtimeModels: ['gpt-5.4-mini'] });

    await expect(service.create({ ...INPUT, models: ['gpt-5.4-mini', 'claude-opus-5'] }, 'master'))
      .rejects.toMatchObject({ statusCode: 400, code: 'model_not_allowed', details: { models: ['claude-opus-5'] } });
    expect(client.generateKey).not.toHaveBeenCalled();
  });

  it('accepts any model when the runtime key allows all models', async () => {
    for (const runtimeModels of [[], ['all-proxy-models']]) {
      const { service } = createDeps({ runtimeModels });
      await expect(service.create({ ...INPUT, models: ['anything-new'] }, 'master')).resolves.toMatchObject({
        models: ['anything-new'],
      });
    }
  });

  it('refuses a key for tags whose budget is used up', async () => {
    const { service, client } = createDeps({ headroom: { remainingUsd: 0, limitUsd: 500, spentUsd: 512 } });

    const failure = await service.create(INPUT, 'master').catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CampaignKeyError);
    expect(failure).toMatchObject({ statusCode: 409, code: 'budget_exhausted' });
    expect((failure as Error).message).toContain('Bugfarm November');
    expect(client.generateKey).not.toHaveBeenCalled();
  });

  it('rejects an unknown notify agent and an expiry that is not in the future', async () => {
    const { service } = createDeps();

    await expect(service.create({ ...INPUT, notifyAgentId: 'agent-missing' }, 'master'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({ ...INPUT, expiresAt: NOW + 1_000 }, 'master'))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({ ...INPUT, notifyAgentId: 'agent-1' }, 'master'))
      .resolves.toMatchObject({ notifyAgentId: 'agent-1' });
  });

  it('reports a gateway failure as 502 without key material', async () => {
    const { service, client } = createDeps();
    client.generateKey.mockRejectedValue(
      new LiteLLMKeyAdminError('key/generate', 500, 'sk-<redacted> upstream down'),
    );

    await expect(service.create(INPUT, 'master')).rejects.toMatchObject({
      statusCode: 502,
      code: 'model_gateway_unavailable',
    });
  });

  it('deletes the minted key when the record cannot be stored', async () => {
    const { service, client, db } = createDeps();
    db.createModelGatewayCampaignKey.mockRejectedValue(new Error('db down'));

    await expect(service.create(INPUT, 'master')).rejects.toThrow('db down');
    const alias = client.generateKey.mock.calls[0]?.[0].keyAlias;
    expect(client.deleteKeysByAlias).toHaveBeenCalledWith([alias]);
  });
});

describe('CampaignGatewayKeyService.revoke', () => {
  it('deletes the gateway key once, stamps the record, and stays idempotent', async () => {
    const { service, client } = createDeps();
    const created = await service.create(INPUT, 'master');

    const revoked = await service.revoke(created.id);
    expect(client.deleteKeysByAlias).toHaveBeenCalledWith([`stablehand-campaign-${created.id}`]);
    expect(revoked).toMatchObject({ id: created.id, status: 'revoked', revokedAt: NOW });
    expect(revoked).not.toHaveProperty('key');

    await expect(service.revoke(created.id)).resolves.toMatchObject({ status: 'revoked' });
    expect(client.deleteKeysByAlias).toHaveBeenCalledTimes(1);
    await expect(service.revoke('gck_missing')).resolves.toBeUndefined();
  });

  it('leaves the record active when the gateway cannot delete the key', async () => {
    const { service, client, rows } = createDeps();
    const created = await service.create(INPUT, 'master');
    client.deleteKeysByAlias.mockRejectedValue(new LiteLLMKeyAdminError('key/delete', 503, 'unavailable'));

    await expect(service.revoke(created.id)).rejects.toMatchObject({ statusCode: 502 });
    expect(rows.get(created.id)?.revokedAt).toBeNull();
  });
});

describe('campaignKeyStatus', () => {
  it('derives active, expired and revoked', () => {
    expect(campaignKeyStatus({ revokedAt: null, expiresAt: NOW + 1 }, NOW)).toBe('active');
    expect(campaignKeyStatus({ revokedAt: null, expiresAt: NOW }, NOW)).toBe('expired');
    expect(campaignKeyStatus({ revokedAt: NOW - 1, expiresAt: NOW + 1 }, NOW)).toBe('revoked');
  });
});
