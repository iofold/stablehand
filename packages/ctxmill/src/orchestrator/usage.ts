import { TurnUsageSchema, type TurnUsage } from '@ctxmill/contracts';

interface AggregateUsageInput {
  usage?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
}

/**
 * Materialize the canonical public usage envelope from a terminal aggregate.
 * Aggregate-only harness data intentionally does not fabricate model-call
 * counts. The model-call ledger can replace the cost coverage later.
 */
export function materializeTurnUsage(
  usage: AggregateUsageInput | null | undefined,
  options: { gatewayPending?: boolean } = {},
): TurnUsage | null {
  const nested = TurnUsageSchema.safeParse(usage?.usage);
  if (nested.success) return nested.data;

  const canonical = TurnUsageSchema.safeParse(usage);
  if (canonical.success) return canonical.data;

  if (
    usage?.inputTokens == null
    || usage.outputTokens == null
    || usage.totalTokens == null
  ) {
    return null;
  }

  if (options.gatewayPending) {
    return TurnUsageSchema.parse({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      modelCalls: {
        observed: 0,
        costKnown: 0,
        expected: null,
      },
      cost: {
        totalUsd: null,
        knownUsd: 0,
        coverage: 'pending',
      },
    });
  }

  const hasCost = usage.costUsd != null;
  return TurnUsageSchema.parse({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    modelCalls: {
      observed: 0,
      costKnown: 0,
      expected: null,
    },
    cost: hasCost
      ? {
        totalUsd: usage.costUsd,
        knownUsd: usage.costUsd,
        coverage: 'complete',
      }
      : {
        totalUsd: null,
        knownUsd: 0,
        coverage: 'unpriced',
      },
  });
}
