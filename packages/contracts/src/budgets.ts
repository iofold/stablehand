import { z } from 'zod';

import { EpochMillisSchema as EpochMillisecondsSchema } from './time.js';

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

/** Warn thresholds a policy may carry, e.g. alerts at 50% and 85% of its limit. */
export const MAX_BUDGET_WARN_ACTIONS = 4;

export const BudgetPolicyDocSchema = z.strictObject({
  selector: z.record(z.string(), z.string()),
  groupBy: z.string().trim().min(1).optional(),
  window: BudgetWindowSchema,
  limits: BudgetLimitsSchema,
  actions: z.array(BudgetActionSchema).min(1).max(MAX_BUDGET_WARN_ACTIONS + 1),
}).superRefine((doc, ctx) => {
  const warns = doc.actions.filter((action) => action.action === 'warn');
  const blocks = doc.actions.filter((action) => action.action === 'block');
  if (blocks.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: 'At most one block action is allowed',
    });
  }
  if (warns.length > MAX_BUDGET_WARN_ACTIONS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: `At most ${MAX_BUDGET_WARN_ACTIONS} warn actions are allowed`,
    });
  }
  if (new Set(warns.map((action) => action.threshold)).size !== warns.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: 'Each warn action needs its own threshold',
    });
  }

  const block = blocks[0];
  if (block && warns.some((warn) => warn.threshold >= block.threshold)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: 'Every warn threshold must be lower than the block threshold',
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

/**
 * Error code carried by a run that the model gateway stopped mid-run because
 * the run's own spend cap ran out (a per-run limit or the remaining headroom
 * of a blocking budget policy). Distinct from `budget_exceeded`, which is the
 * admission-time refusal of a run that never started.
 */
export const BUDGET_REACHED_CODE = 'budget_reached';

/**
 * Error code for a gateway budget refusal Stablehand did not set: an
 * operations-owned ceiling on the shared gateway credential. It never names a
 * Stablehand policy or bucket.
 */
export const MODEL_GATEWAY_BUDGET_EXCEEDED_CODE = 'model_gateway_budget_exceeded';

export const TurnSpendCapSourceSchema = z.enum([
  // harnessConfig.limits.maxCostUsd on the agent definition
  'run_limit',
  // remaining headroom of a matching blocking budget policy at run start
  'budget_policy',
]);

/** Why a terminal turn stopped, when that reason is a typed outcome. */
export const TurnStopReasonSchema = z.discriminatedUnion('code', [
  z.strictObject({
    code: z.literal(BUDGET_REACHED_CODE),
    source: TurnSpendCapSourceSchema,
    /** The run's spend cap in USD. */
    capUsd: z.number().finite().nonnegative(),
    /** Spend the gateway had counted against the cap when it refused; null when unknown. */
    spentUsd: z.number().finite().nonnegative().nullable(),
    policyId: z.string().trim().min(1).optional(),
    policyName: z.string().trim().min(1).optional(),
    bucket: z.string().optional(),
  }),
  z.strictObject({
    code: z.literal(MODEL_GATEWAY_BUDGET_EXCEEDED_CODE),
    spentUsd: z.number().finite().nonnegative().nullable(),
    limitUsd: z.number().finite().nonnegative().nullable(),
  }),
]);

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
export type TurnSpendCapSource = z.infer<typeof TurnSpendCapSourceSchema>;
export type TurnStopReason = z.infer<typeof TurnStopReasonSchema>;

/** Dollar amount for stop-reason copy: cents from a cent up, two significant digits below. */
export function formatSpendUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.000001) return '<$0.000001';
  if (value < 0.01) return `$${Number(value.toPrecision(2))}`;
  // Under a dollar, keep up to four decimals so a run that stopped one call
  // past a $0.05 cap reads $0.0512, not a rounded-up $0.05 or $0.06.
  if (value < 1) return `$${value.toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1')}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Plain-language description of a typed stop, shared by the API's turn error
 * text and the dashboard banner so both say the same thing. States the
 * consequence for the run, not the gateway mechanism.
 */
export function describeTurnStopReason(reason: TurnStopReason): { summary: string; detail: string | null } {
  if (reason.code === BUDGET_REACHED_CODE) {
    const spent = reason.spentUsd !== null ? `It had spent ${formatSpendUsd(reason.spentUsd)}.` : null;
    const summary = `Stopped: this run reached its ${formatSpendUsd(reason.capUsd)} spend cap`;
    if (reason.source === 'budget_policy') {
      const where = reason.policyName
        ? `the "${reason.policyName}" budget${reason.bucket ? ` for ${reason.bucket}` : ''}`
        : 'its budget';
      return {
        summary,
        detail: [`That was what remained of ${where} when the run started.`, spent].filter(Boolean).join(' '),
      };
    }
    return {
      summary,
      detail: [spent, 'The cap is this agent\'s per-run spend limit.'].filter(Boolean).join(' '),
    };
  }
  const amounts = reason.limitUsd !== null
    ? ` (${reason.spentUsd !== null ? `${formatSpendUsd(reason.spentUsd)} of ` : ''}${formatSpendUsd(reason.limitUsd)})`
    : '';
  return {
    summary: 'Stopped: the model gateway refused further model calls for budget',
    detail: `The gateway's own spending limit was reached${amounts}. New runs fail the same way until an operator raises it.`,
  };
}

/** One-line form of {@link describeTurnStopReason}, used as the turn's error text. */
export function turnStopReasonMessage(reason: TurnStopReason): string {
  const { summary, detail } = describeTurnStopReason(reason);
  return detail ? `${summary}. ${detail}` : `${summary}.`;
}
