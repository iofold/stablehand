import { z } from 'zod';

const UsdSchema = z.number().finite().nonnegative();

export const TurnUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  modelCalls: z.strictObject({
    observed: z.number().int().nonnegative(),
    costKnown: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative().nullable(),
  }).superRefine((modelCalls, ctx) => {
    if (modelCalls.costKnown > modelCalls.observed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['costKnown'],
        message: 'Cost-known calls cannot exceed observed calls',
      });
    }
    if (
      modelCalls.expected !== null
      && modelCalls.observed > modelCalls.expected
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expected'],
        message: 'Observed calls cannot exceed expected calls',
      });
    }
  }),
  cost: z.strictObject({
    totalUsd: UsdSchema.nullable(),
    knownUsd: UsdSchema,
    coverage: z.enum(['pending', 'complete', 'partial', 'unpriced']),
  }).superRefine((cost, ctx) => {
    if (cost.coverage === 'complete') {
      if (cost.totalUsd === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['totalUsd'],
          message: 'Complete cost coverage requires a total',
        });
      } else if (cost.totalUsd !== cost.knownUsd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['totalUsd'],
          message: 'Complete total must equal the known cost',
        });
      }
      return;
    }

    if (cost.totalUsd !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalUsd'],
        message: 'Incomplete cost coverage cannot claim a total',
      });
    }
    if (cost.coverage === 'unpriced' && cost.knownUsd !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['knownUsd'],
        message: 'Unpriced usage cannot contain known cost',
      });
    }
  }),
});

export type TurnUsage = z.infer<typeof TurnUsageSchema>;
