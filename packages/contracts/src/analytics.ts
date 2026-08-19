import { z } from 'zod';

import { EpochMillisSchema as EpochMillisecondsSchema } from './time.js';

const CountSchema = z.number().int().nonnegative();
const UsdSchema = z.number().finite().nonnegative();

export const AnalyticsWindowSchema = z.enum(['24h', '7d', '30d']);

export const AnalyticsOverviewQuerySchema = z.strictObject({
  window: AnalyticsWindowSchema.default('24h'),
});

export const AnalyticsCostCoverageSchema = z.strictObject({
  complete: CountSchema,
  partial: CountSchema,
  pending: CountSchema,
  unpriced: CountSchema,
});

export const AnalyticsMetricsSchema = z.strictObject({
  turns: CountSchema,
  completedTurns: CountSchema,
  errorTurns: CountSchema,
  cancelledTurns: CountSchema,
  activeTurns: CountSchema,
  inputTokens: CountSchema,
  outputTokens: CountSchema,
  totalTokens: CountSchema,
  tokenReportedTurns: CountSchema,
  knownCostUsd: UsdSchema,
  costCoverage: AnalyticsCostCoverageSchema,
}).superRefine((metrics, ctx) => {
  const statusTurns = metrics.completedTurns
    + metrics.errorTurns
    + metrics.cancelledTurns
    + metrics.activeTurns;
  if (statusTurns !== metrics.turns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['turns'],
      message: 'Turn status counts must equal total turns',
    });
  }
  if (metrics.tokenReportedTurns > metrics.turns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tokenReportedTurns'],
      message: 'Token-reported turns cannot exceed total turns',
    });
  }
  const costCoveredTurns = Object.values(metrics.costCoverage)
    .reduce((total, count) => total + count, 0);
  if (costCoveredTurns !== metrics.turns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['costCoverage'],
      message: 'Cost coverage counts must equal total turns',
    });
  }
});

export const AnalyticsActivityBucketSchema = AnalyticsMetricsSchema.safeExtend({
  from: EpochMillisecondsSchema,
  to: EpochMillisecondsSchema,
}).refine((bucket) => bucket.to > bucket.from, {
  path: ['to'],
  message: 'Activity bucket end must be after its start',
});

export const AnalyticsAgentActivitySchema = AnalyticsMetricsSchema.safeExtend({
  agentId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  harness: z.string().trim().min(1),
  model: z.string().trim().min(1).nullable(),
  lastActivityAt: EpochMillisecondsSchema.nullable(),
});

export const AnalyticsTotalsSchema = AnalyticsMetricsSchema.safeExtend({
  agents: CountSchema,
  activeAgents: CountSchema,
}).refine((totals) => totals.activeAgents <= totals.agents, {
  path: ['activeAgents'],
  message: 'Active agents cannot exceed total agents',
});

export const AnalyticsOverviewSchema = z.strictObject({
  window: AnalyticsWindowSchema,
  from: EpochMillisecondsSchema,
  to: EpochMillisecondsSchema,
  bucketSizeMs: z.number().int().positive(),
  totals: AnalyticsTotalsSchema,
  activity: z.array(AnalyticsActivityBucketSchema).max(720),
  agents: z.array(AnalyticsAgentActivitySchema).max(10_000),
}).refine((overview) => overview.to > overview.from, {
  path: ['to'],
  message: 'Analytics range end must be after its start',
});

export type AnalyticsWindow = z.infer<typeof AnalyticsWindowSchema>;
export type AnalyticsOverviewQuery = z.infer<typeof AnalyticsOverviewQuerySchema>;
export type AnalyticsCostCoverage = z.infer<typeof AnalyticsCostCoverageSchema>;
export type AnalyticsMetrics = z.infer<typeof AnalyticsMetricsSchema>;
export type AnalyticsActivityBucket = z.infer<typeof AnalyticsActivityBucketSchema>;
export type AnalyticsAgentActivity = z.infer<typeof AnalyticsAgentActivitySchema>;
export type AnalyticsTotals = z.infer<typeof AnalyticsTotalsSchema>;
export type AnalyticsOverview = z.infer<typeof AnalyticsOverviewSchema>;
