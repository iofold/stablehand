import { z } from 'zod';

const EpochMillisecondsSchema = z.number().int().nonnegative();
const PositiveFiniteSchema = z.number().finite().positive();
const PositiveIntegerSchema = z.number().int().positive();

export const BudgetWindowSchema = z.enum([
  'rolling-1h',
  'rolling-24h',
  'rolling-7d',
  'rolling-30d',
  'month-to-date',
]);

export const BudgetMetricSchema = z.enum([
  'totalTokens',
  'costUsd',
  'turns',
]);

export const BudgetLimitsSchema = z.strictObject({
  totalTokens: PositiveIntegerSchema.optional(),
  costUsd: PositiveFiniteSchema.optional(),
  turns: PositiveIntegerSchema.optional(),
}).refine(
  (limits) => Object.values(limits).some((value) => value !== undefined),
  'At least one budget limit is required',
);

export const BudgetActionSchema = z.strictObject({
  threshold: z.number().finite().gt(0).lte(1),
  action: z.enum(['warn', 'block']),
});

export const BudgetPolicyDocSchema = z.strictObject({
  selector: z.record(z.string(), z.string()),
  groupBy: z.string().trim().min(1).optional(),
  window: BudgetWindowSchema,
  limits: BudgetLimitsSchema,
  actions: z.array(BudgetActionSchema).min(1).max(2),
}).superRefine((doc, ctx) => {
  const byAction = new Map(doc.actions.map((action) => [action.action, action]));
  if (byAction.size !== doc.actions.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: 'At most one warn and one block action are allowed',
    });
  }

  const warn = byAction.get('warn');
  const block = byAction.get('block');
  if (warn && block && warn.threshold >= block.threshold) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: 'The warn threshold must be lower than the block threshold',
    });
  }
}).transform((doc) => ({
  ...doc,
  actions: [...doc.actions].sort((a, b) => a.threshold - b.threshold),
}));

export const BudgetPolicyCreateInputSchema = z.strictObject({
  name: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  doc: BudgetPolicyDocSchema,
});

export const BudgetPolicyPatchInputSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  doc: BudgetPolicyDocSchema.optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  'At least one budget policy field is required',
);

export const BudgetPolicySchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  doc: BudgetPolicyDocSchema,
  createdAt: EpochMillisecondsSchema,
  updatedAt: EpochMillisecondsSchema,
});

export const BudgetPolicyListResponseSchema = z.strictObject({
  policies: z.array(BudgetPolicySchema),
});

export const BudgetBucketSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('all'),
  }),
  z.strictObject({
    kind: z.literal('untagged'),
    key: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('tag'),
    key: z.string().min(1),
    value: z.string(),
  }),
]);

export const BudgetUsageAggregateSchema = z.strictObject({
  totalTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
  turns: z.number().int().nonnegative(),
  tokenReportedTurnCount: z.number().int().nonnegative(),
  costReportedTurnCount: z.number().int().nonnegative(),
}).superRefine((aggregate, ctx) => {
  if (aggregate.tokenReportedTurnCount > aggregate.turns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tokenReportedTurnCount'],
      message: 'Token-reported turns cannot exceed total turns',
    });
  }
  if (aggregate.costReportedTurnCount > aggregate.turns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['costReportedTurnCount'],
      message: 'Cost-reported turns cannot exceed total turns',
    });
  }
});

export const BudgetMetricStatusSchema = z.strictObject({
  metric: BudgetMetricSchema,
  spent: z.number().finite().nonnegative().nullable(),
  limit: PositiveFiniteSchema,
  ratio: z.number().finite().nonnegative().nullable(),
  state: z.enum(['ok', 'warning', 'blocked']),
  action: BudgetActionSchema.nullable(),
});

export const BudgetSpendBucketSchema = z.strictObject({
  bucket: BudgetBucketSchema,
  spend: BudgetUsageAggregateSchema,
  statuses: z.array(BudgetMetricStatusSchema),
});

export const BudgetSpendResponseSchema = z.strictObject({
  policyId: z.string().trim().min(1),
  window: BudgetWindowSchema,
  windowStart: EpochMillisecondsSchema,
  buckets: z.array(BudgetSpendBucketSchema),
});

export const AgentBudgetStatusSchema = z.strictObject({
  agentId: z.string().trim().min(1),
  state: z.enum(['ok', 'warning', 'blocked']),
  evaluatedAt: EpochMillisecondsSchema,
  matches: z.array(z.strictObject({
    policyId: z.string().trim().min(1),
    policyName: z.string().trim().min(1),
    bucket: BudgetBucketSchema,
    statuses: z.array(BudgetMetricStatusSchema),
  })),
});

export const AgentBudgetStatusListResponseSchema = z.strictObject({
  statuses: z.array(AgentBudgetStatusSchema),
});

export const BudgetExceededResponseSchema = z.strictObject({
  error: z.string().min(1),
  code: z.literal('budget_exceeded'),
  policyId: z.string().trim().min(1),
  policyName: z.string().trim().min(1),
  bucket: BudgetBucketSchema,
  metric: BudgetMetricSchema,
  spent: z.number().finite().nonnegative(),
  limit: PositiveFiniteSchema,
});

export type BudgetWindow = z.infer<typeof BudgetWindowSchema>;
export type BudgetMetric = z.infer<typeof BudgetMetricSchema>;
export type BudgetLimits = z.infer<typeof BudgetLimitsSchema>;
export type BudgetAction = z.infer<typeof BudgetActionSchema>;
export type BudgetPolicyDoc = z.infer<typeof BudgetPolicyDocSchema>;
export type BudgetPolicyCreateInput = z.input<typeof BudgetPolicyCreateInputSchema>;
export type BudgetPolicyPatchInput = z.infer<typeof BudgetPolicyPatchInputSchema>;
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;
export type BudgetBucket = z.infer<typeof BudgetBucketSchema>;
export type BudgetUsageAggregate = z.infer<typeof BudgetUsageAggregateSchema>;
export type BudgetMetricStatus = z.infer<typeof BudgetMetricStatusSchema>;
export type BudgetSpendResponse = z.infer<typeof BudgetSpendResponseSchema>;
export type AgentBudgetStatus = z.infer<typeof AgentBudgetStatusSchema>;
export type BudgetExceededResponse = z.infer<typeof BudgetExceededResponseSchema>;
