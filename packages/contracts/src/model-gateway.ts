import { z } from 'zod';

import { DurationMsSchema, EpochMillisSchema as EpochMillisecondsSchema } from './time.js';


export const ModelGatewayStatusSchema = z.strictObject({
  enabled: z.boolean(),
  profile: z.string().trim().min(1).nullable(),
  revision: z.string().trim().min(1).nullable(),
  state: z.enum(['disabled', 'initializing', 'healthy', 'degraded']),
  watermarkAt: EpochMillisecondsSchema.nullable(),
  lastAttemptAt: EpochMillisecondsSchema.nullable(),
  lastSuccessAt: EpochMillisecondsSchema.nullable(),
  lagMs: DurationMsSchema.nullable(),
  lastError: z.string().nullable(),
  pendingCalls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  quarantinedTransactions: z.number().int().nonnegative(),
  orphanTransactions: z.number().int().nonnegative(),
  // Completed gateway-attributed turns whose usage was never reconciled.
  // Nonzero while ingestion is disabled (config lost) or when a spend row
  // was lost upstream — both must read as degraded, never as silence.
  awaitingTurns: z.number().int().nonnegative(),
  oldestAwaitingAt: EpochMillisecondsSchema.nullable(),
});

export type ModelGatewayStatus = z.infer<typeof ModelGatewayStatusSchema>;

export const ModelGatewayQuarantineReasonSchema = z.enum([
  'invalid_payload',
  'missing_correlation',
  'invalid_correlation',
  'correlation_mismatch',
  'unknown_turn',
  // A transaction already attached to a different turn (the reconciler
  // quarantines instead of aborting the batch).
  'attached_elsewhere',
  // A campaign-key transaction whose key record is missing.
  'unknown_campaign_key',
]);

export const ModelGatewayQuarantineReasonCountSchema = z.strictObject({
  reason: ModelGatewayQuarantineReasonSchema,
  total: z.number().int().nonnegative(),
  recentTotal: z.number().int().nonnegative(),
  lastSeenAt: EpochMillisecondsSchema.nullable(),
});

export const ModelGatewayQuarantineEntrySchema = z.strictObject({
  transactionId: z.string().min(1),
  correlationId: z.string().nullable(),
  reason: ModelGatewayQuarantineReasonSchema,
  occurrences: z.number().int().positive(),
  firstSeenAt: EpochMillisecondsSchema,
  lastSeenAt: EpochMillisecondsSchema,
  // Only reconciler-sanitized safe fields (model, provider, status); never a
  // raw gateway payload.
  sanitizedPayload: z.record(z.string(), z.unknown()),
});

/**
 * Breakdown of gateway spend transactions that could not be attached to a
 * turn, grouped by reason with recency so operators can tell a growing
 * problem from historical noise. unknown_turn entries are real spend that
 * matched no turn; every other reason is a record that failed validation.
 */
export const ModelGatewayQuarantineSchema = z.strictObject({
  enabled: z.boolean(),
  profile: z.string().trim().min(1).nullable(),
  recentSince: EpochMillisecondsSchema.nullable(),
  total: z.number().int().nonnegative(),
  recentTotal: z.number().int().nonnegative(),
  reasons: z.array(ModelGatewayQuarantineReasonCountSchema),
  recent: z.array(ModelGatewayQuarantineEntrySchema),
});

export type ModelGatewayQuarantine = z.infer<typeof ModelGatewayQuarantineSchema>;
export type ModelGatewayQuarantineReason = z.infer<typeof ModelGatewayQuarantineReasonSchema>;

/**
 * Campaign gateway keys (ctx-hmm3): a LiteLLM virtual key for model calls
 * made outside Stablehand turns, such as an evaluation runner on the host.
 * Its spend is attributed to `tags`, so the budget policies that select
 * those tags count it alongside tagged turns.
 */
export const ModelGatewayCampaignKeyStatusSchema = z.enum(['active', 'expired', 'revoked']);

const CampaignTagsSchema = z.record(z.string().trim().min(1), z.string().min(1).max(256))
  .refine(
    (tags) => Object.keys(tags).length > 0,
    'At least one tag is required: campaign spend is attributed by its tags',
  );

export const ModelGatewayCampaignKeyCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  tags: CampaignTagsSchema,
  /** Gateway model names the key may call; each must be allowed for the runtime key. */
  models: z.array(z.string().trim().min(1)).min(1).max(200)
    .refine((models) => new Set(models).size === models.length, 'Models must be unique'),
  /** Upper bound on the key's spend in USD; the gateway refuses calls past it. */
  maxBudgetUsd: z.number().finite().positive().optional(),
  /** When the key stops working. Defaults to 30 days from creation. */
  expiresAt: EpochMillisecondsSchema.optional(),
  /** Agent whose `budget.threshold` webhooks receive this campaign's budget alerts. */
  notifyAgentId: z.string().trim().min(1).optional(),
});

export const ModelGatewayCampaignKeySpendSchema = z.strictObject({
  /** Known cost of ingested calls; unpriced calls add nothing. */
  costUsd: z.number().finite().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  lastSpendAt: EpochMillisecondsSchema.nullable(),
});

export const ModelGatewayCampaignKeySchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  tags: z.record(z.string(), z.string()),
  models: z.array(z.string()),
  keyAlias: z.string().trim().min(1),
  requestedMaxBudgetUsd: z.number().finite().positive().nullable(),
  /** The spend cap the gateway enforces on the key; null when none. */
  maxBudgetUsd: z.number().finite().nonnegative().nullable(),
  /** What set `maxBudgetUsd`: the request, or a budget policy's remaining headroom. */
  capSource: z.enum(['request', 'budget_policy']).nullable(),
  capPolicyId: z.string().nullable(),
  capPolicyName: z.string().nullable(),
  notifyAgentId: z.string().nullable(),
  status: ModelGatewayCampaignKeyStatusSchema,
  createdAt: EpochMillisecondsSchema,
  createdBy: z.string().nullable(),
  expiresAt: EpochMillisecondsSchema.nullable(),
  revokedAt: EpochMillisecondsSchema.nullable(),
  spend: ModelGatewayCampaignKeySpendSchema,
});

/** Creation response: the only time the key itself is returned. */
export const ModelGatewayCampaignKeyCreatedSchema = ModelGatewayCampaignKeySchema.extend({
  key: z.string().min(1),
});

export const ModelGatewayCampaignKeyListResponseSchema = z.strictObject({
  campaignKeys: z.array(ModelGatewayCampaignKeySchema),
});

export type ModelGatewayCampaignKeyStatus = z.infer<typeof ModelGatewayCampaignKeyStatusSchema>;
export type ModelGatewayCampaignKeyCreateInput = z.infer<typeof ModelGatewayCampaignKeyCreateInputSchema>;
export type ModelGatewayCampaignKeySpend = z.infer<typeof ModelGatewayCampaignKeySpendSchema>;
export type ModelGatewayCampaignKey = z.infer<typeof ModelGatewayCampaignKeySchema>;
export type ModelGatewayCampaignKeyCreated = z.infer<typeof ModelGatewayCampaignKeyCreatedSchema>;
export type ModelGatewayCampaignKeyListResponse = z.infer<typeof ModelGatewayCampaignKeyListResponseSchema>;
