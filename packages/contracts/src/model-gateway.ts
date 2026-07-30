import { z } from 'zod';

const EpochMillisecondsSchema = z.number().int().nonnegative();

export const ModelGatewayStatusSchema = z.strictObject({
  enabled: z.boolean(),
  profile: z.string().trim().min(1).nullable(),
  revision: z.string().trim().min(1).nullable(),
  state: z.enum(['disabled', 'initializing', 'healthy', 'degraded']),
  watermarkAt: EpochMillisecondsSchema.nullable(),
  lastAttemptAt: EpochMillisecondsSchema.nullable(),
  lastSuccessAt: EpochMillisecondsSchema.nullable(),
  lagMs: EpochMillisecondsSchema.nullable(),
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
