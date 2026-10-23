import { liteLLMKeyHash } from './litellm-key-client.js';

/**
 * Which gateway keys Stablehand issued, and what their spend rows mean
 * (ctx-gfp8, ctx-hmm3).
 *
 * A LiteLLM gateway can be shared with other workloads that bring their own
 * virtual keys. Their spend is none of Stablehand's business: it must not be
 * quarantined, stored, or allowed to crowd Stablehand's own rows out of the
 * reconciler's fetch window. Rows are therefore classified by the key that
 * made the call:
 *
 * - `turn`: the shared runtime key or a per-session key. These rows carry a
 *   turn correlation; uncorrelated ones are quarantined as before.
 * - `campaign`: a campaign key (minted for work outside Stablehand turns, such
 *   as an evaluation runner on the host). Attributed to the campaign's tags.
 * - `foreign`: any other key. Counted and skipped.
 *
 * Identification uses LiteLLM's spend-log `api_key` (the key's SHA-256 token
 * hash) and `metadata.user_api_key_alias`, both recorded by LiteLLM 1.93 on
 * every authenticated call.
 */

/** Alias prefix of per-session keys (ADR 024). */
export const SESSION_KEY_ALIAS_PREFIX = 'stablehand-session-';
/** Alias prefix of campaign keys. */
export const CAMPAIGN_KEY_ALIAS_PREFIX = 'stablehand-campaign-';

/**
 * One spend-log query stream. LiteLLM 1.93's `/spend/logs/v2` matches
 * `api_key` exactly and `key_alias` as a substring of the alias; each filter
 * is paged on its own.
 */
export type SpendKeyFilter = { apiKey: string } | { keyAlias: string };

export type GatewayKeyClass =
  | { kind: 'turn' }
  | { kind: 'campaign'; campaignKeyId: string }
  | { kind: 'foreign' };

export interface GatewayKeyIdentity {
  /** LiteLLM token hash from the spend row's `api_key`. */
  hash?: string;
  /** `metadata.user_api_key_alias` from the spend row. */
  alias?: string;
}

export interface IssuedGatewayKeys {
  /** Spend-log filters that together cover every key Stablehand issued. */
  readonly filters: readonly SpendKeyFilter[];
  classify(key: GatewayKeyIdentity): GatewayKeyClass;
}

export function createIssuedGatewayKeys(params: {
  runtimeKey: string;
  campaignKeys?: Iterable<{ id: string; keyHash: string }>;
}): IssuedGatewayKeys {
  const runtimeKeyHash = liteLLMKeyHash(params.runtimeKey);
  const campaignKeyIds = new Map<string, string>();
  for (const key of params.campaignKeys ?? []) {
    campaignKeyIds.set(key.keyHash, key.id);
  }
  const filters: SpendKeyFilter[] = [
    { apiKey: runtimeKeyHash },
    { keyAlias: SESSION_KEY_ALIAS_PREFIX },
    { keyAlias: CAMPAIGN_KEY_ALIAS_PREFIX },
  ];
  return {
    filters,
    classify(key) {
      // Without a key hash the row cannot be placed; keep the pre-ctx-gfp8
      // behaviour (treat it as Stablehand's, so it is attached or quarantined)
      // rather than silently dropping spend that may be ours.
      if (!key.hash) return { kind: 'turn' };
      const campaignKeyId = campaignKeyIds.get(key.hash);
      if (campaignKeyId) return { kind: 'campaign', campaignKeyId };
      if (key.hash === runtimeKeyHash) return { kind: 'turn' };
      if (key.alias?.startsWith(SESSION_KEY_ALIAS_PREFIX)) return { kind: 'turn' };
      // A campaign-shaped alias whose hash Stablehand has no record of was
      // minted elsewhere (e.g. another deployment sharing the gateway): mint
      // stores the record before the secret is ever handed out.
      return { kind: 'foreign' };
    },
  };
}
