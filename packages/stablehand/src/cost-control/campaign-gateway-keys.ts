import { randomUUID } from 'node:crypto';

import {
  formatSpendUsd,
  type ModelGatewayCampaignKey,
  type ModelGatewayCampaignKeyCreateInput,
  type ModelGatewayCampaignKeyCreated,
  type ModelGatewayCampaignKeyStatus,
} from '@stablehand/contracts';

import type {
  CampaignKeySpendSummary,
  DatabaseRepository,
} from '../database/repository.js';
import type { ModelGatewayCampaignKeyRow } from '../database/types.js';
import type { PolicyCostHeadroom } from '../orchestrator/budget-enforcer.js';
import { CAMPAIGN_KEY_ALIAS_PREFIX } from './issued-gateway-keys.js';
import { liteLLMKeyHash, type LiteLLMKeyClient } from './litellm-key-client.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** Backstop lifetime for a campaign key created without `expiresAt`. */
export const DEFAULT_CAMPAIGN_KEY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** An expiry closer than this is refused: the key would be dead on arrival. */
const MIN_CAMPAIGN_KEY_LIFETIME_MS = 60_000;
/** LiteLLM's wildcard model grant; a runtime key holding it allows any model. */
const ALL_PROXY_MODELS = 'all-proxy-models';
const TAG = '[CampaignGatewayKeys]';

const EMPTY_SPEND: CampaignKeySpendSummary = {
  costUsd: 0,
  totalTokens: 0,
  calls: 0,
  unpricedCalls: 0,
  lastSpendAt: null,
};

/** A refusal with an HTTP status, a stable code, and plain-language text. */
export class CampaignKeyError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CampaignKeyError';
  }
}

export function campaignKeyAlias(id: string): string {
  return `${CAMPAIGN_KEY_ALIAS_PREFIX}${id}`;
}

export function campaignKeyStatus(
  row: Pick<ModelGatewayCampaignKeyRow, 'revokedAt' | 'expiresAt'>,
  now: number,
): ModelGatewayCampaignKeyStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt !== null && row.expiresAt <= now) return 'expired';
  return 'active';
}

/** The public view of a campaign key: never its secret, nor its hash. */
export function toPublicCampaignKey(
  row: ModelGatewayCampaignKeyRow,
  spend: CampaignKeySpendSummary | undefined,
  now: number,
): ModelGatewayCampaignKey {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    models: row.models,
    keyAlias: row.keyAlias,
    requestedMaxBudgetUsd: row.requestedMaxBudgetUsd ?? null,
    maxBudgetUsd: row.maxBudgetUsd ?? null,
    capSource: row.capSource ?? null,
    capPolicyId: row.capPolicyId ?? null,
    capPolicyName: row.capPolicyName ?? null,
    notifyAgentId: row.notifyAgentId ?? null,
    status: campaignKeyStatus(row, now),
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
    expiresAt: row.expiresAt ?? null,
    revokedAt: row.revokedAt ?? null,
    spend: spend ?? EMPTY_SPEND,
  };
}

type CampaignKeyStore = Pick<
  DatabaseRepository,
  | 'createModelGatewayCampaignKey'
  | 'getModelGatewayCampaignKey'
  | 'markModelGatewayCampaignKeyRevoked'
  | 'getModelGatewayCampaignKeySpend'
  | 'getAgent'
>;

export interface CampaignGatewayKeyServiceDeps {
  client: Pick<LiteLLMKeyClient, 'generateKey' | 'deleteKeysByAlias' | 'getKeyModels'>;
  /** The shared runtime key; a campaign key may only use models it allows. */
  runtimeKey: string;
  db: CampaignKeyStore;
  /** Remaining headroom of the tightest matching blocking cost policy (BudgetEnforcer.costHeadroom). */
  resolvePolicyHeadroom: (tags: Record<string, string>) => Promise<PolicyCostHeadroom | null>;
  logger: Logger;
  now?: () => number;
}

/** Exact names, or LiteLLM wildcard entries such as `openai/*`. */
function runtimeAllows(runtimeModels: readonly string[], model: string): boolean {
  return runtimeModels.some((allowed) => (
    allowed === model
    || (allowed.endsWith('*') && model.startsWith(allowed.slice(0, -1)))
  ));
}

function gatewayFailure(operation: string, err: unknown): CampaignKeyError {
  // LiteLLMKeyAdminError messages are already stripped of key material.
  const detail = err instanceof Error ? err.message : String(err);
  return new CampaignKeyError(
    502,
    'model_gateway_unavailable',
    `The model gateway could not ${operation}: ${detail}`,
  );
}

/**
 * Mints and revokes campaign gateway keys (ctx-hmm3).
 *
 * A campaign key lets a tool that is not a Stablehand turn (e.g. an
 * evaluation runner on the host) call models through the gateway while its
 * spend counts against the budget policies that select the campaign's tags.
 *
 * - Models must be a subset of the runtime key's models.
 * - The key's gateway cap is the lower of the requested `maxBudgetUsd` and
 *   the remaining headroom of the tightest matching policy that blocks on
 *   cost, read when the key is minted. The gateway refuses calls past it.
 * - Only the key's hash is stored; the secret is returned once.
 * - Revoking deletes the key from the gateway; the record stays so spend
 *   that arrives later is still attributed.
 */
export class CampaignGatewayKeyService {
  private readonly now: () => number;

  constructor(private readonly deps: CampaignGatewayKeyServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async create(
    input: ModelGatewayCampaignKeyCreateInput,
    createdBy: string,
  ): Promise<ModelGatewayCampaignKeyCreated> {
    const now = this.now();
    const expiresAt = input.expiresAt ?? now + DEFAULT_CAMPAIGN_KEY_LIFETIME_MS;
    if (expiresAt - now < MIN_CAMPAIGN_KEY_LIFETIME_MS) {
      throw new CampaignKeyError(
        400,
        'invalid_campaign_key_request',
        'expiresAt must be at least one minute in the future',
      );
    }
    if (input.notifyAgentId && !(await this.deps.db.getAgent(input.notifyAgentId))) {
      throw new CampaignKeyError(
        400,
        'invalid_campaign_key_request',
        `Unknown agent '${input.notifyAgentId}' for budget alerts`,
      );
    }

    let runtimeModels: string[];
    try {
      runtimeModels = await this.deps.client.getKeyModels(this.deps.runtimeKey);
    } catch (err) {
      throw gatewayFailure('read the runtime key\'s models', err);
    }
    // An empty list is LiteLLM's "all models".
    if (runtimeModels.length > 0 && !runtimeModels.includes(ALL_PROXY_MODELS)) {
      const refused = input.models.filter((model) => !runtimeAllows(runtimeModels, model));
      if (refused.length > 0) {
        throw new CampaignKeyError(
          400,
          'model_not_allowed',
          `The runtime gateway key does not allow ${refused.join(', ')}; `
          + 'a campaign key can only use models Stablehand runs may use.',
          { models: refused },
        );
      }
    }

    const cap = await this.resolveCap(input);
    const id = `gck_${randomUUID()}`;
    const alias = campaignKeyAlias(id);
    let minted: { key: string; tokenHash: string | null };
    try {
      minted = await this.deps.client.generateKey({
        keyAlias: alias,
        models: input.models,
        maxBudgetUsd: cap?.maxBudgetUsd ?? null,
        duration: `${Math.ceil((expiresAt - now) / 1000)}s`,
        metadata: { stablehand_campaign_key_id: id },
      });
    } catch (err) {
      throw gatewayFailure('create the key', err);
    }

    // Record before handing out the secret: the reconciler recognises a
    // campaign key's spend by this stored hash.
    let row: ModelGatewayCampaignKeyRow;
    try {
      row = await this.deps.db.createModelGatewayCampaignKey({
        id,
        name: input.name,
        tags: input.tags,
        keyAlias: alias,
        keyHash: minted.tokenHash ?? liteLLMKeyHash(minted.key),
        models: input.models,
        requestedMaxBudgetUsd: input.maxBudgetUsd ?? null,
        maxBudgetUsd: cap?.maxBudgetUsd ?? null,
        capSource: cap?.source ?? null,
        capPolicyId: cap?.policyId ?? null,
        capPolicyName: cap?.policyName ?? null,
        notifyAgentId: input.notifyAgentId ?? null,
        createdAt: now,
        createdBy,
        expiresAt,
      });
    } catch (err) {
      await this.deps.client.deleteKeysByAlias([alias]).catch((cleanupErr: unknown) => {
        this.deps.logger.error(
          `${TAG} could not delete gateway key ${alias} after failing to record it; `
          + 'it was never handed out and expires on its own:',
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        );
      });
      throw err;
    }

    this.deps.logger.info(
      `${TAG} minted campaign key ${id} (${alias})`
      + (cap ? ` capped at $${cap.maxBudgetUsd} by ${cap.source}` : ' without a spend cap'),
    );
    return { ...toPublicCampaignKey(row, undefined, now), key: minted.key };
  }

  /**
   * Delete the key from the gateway and stamp the record revoked.
   * Idempotent; undefined when no such key exists.
   */
  async revoke(id: string): Promise<ModelGatewayCampaignKey | undefined> {
    const row = await this.deps.db.getModelGatewayCampaignKey(id);
    if (!row) return undefined;
    if (row.revokedAt === null) {
      try {
        await this.deps.client.deleteKeysByAlias([row.keyAlias]);
      } catch (err) {
        throw gatewayFailure('delete the key', err);
      }
    }
    const revoked = await this.deps.db.markModelGatewayCampaignKeyRevoked(id, this.now()) ?? row;
    if (row.revokedAt === null) {
      this.deps.logger.info(`${TAG} revoked campaign key ${id}`);
    }
    const spend = await this.deps.db.getModelGatewayCampaignKeySpend([id]);
    return toPublicCampaignKey(revoked, spend.get(id), this.now());
  }

  private async resolveCap(input: ModelGatewayCampaignKeyCreateInput): Promise<{
    maxBudgetUsd: number;
    source: 'request' | 'budget_policy';
    policyId?: string;
    policyName?: string;
  } | null> {
    const headroom = await this.deps.resolvePolicyHeadroom(input.tags);
    if (headroom && headroom.remainingUsd <= 0) {
      throw new CampaignKeyError(
        409,
        'budget_exhausted',
        `Budget "${headroom.policyName}"${headroom.bucket ? ` for ${headroom.bucket}` : ''} is used up `
        + `(${formatSpendUsd(headroom.spentUsd)} of ${formatSpendUsd(headroom.limitUsd)}), `
        + 'so a key for these tags could not make a single call.',
        { policyId: headroom.policyId, policyName: headroom.policyName },
      );
    }
    const requested = input.maxBudgetUsd;
    if (requested !== undefined && (!headroom || requested <= headroom.remainingUsd)) {
      return { maxBudgetUsd: requested, source: 'request' };
    }
    if (headroom) {
      return {
        maxBudgetUsd: headroom.remainingUsd,
        source: 'budget_policy',
        policyId: headroom.policyId,
        policyName: headroom.policyName,
      };
    }
    return null;
  }
}
