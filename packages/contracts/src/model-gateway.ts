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
});

export type ModelGatewayStatus = z.infer<typeof ModelGatewayStatusSchema>;
