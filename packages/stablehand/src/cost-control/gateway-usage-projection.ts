import { TurnUsageSchema, type TurnUsage } from '@stablehand/contracts';

import type {
  ModelGatewayCostState,
  ModelGatewayTurnMode,
} from '../database/schema-pg.js';

interface TokenAggregate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface GatewayAttemptUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  costState: ModelGatewayCostState;
}

function sumCompleteAttemptTokens(
  attempts: readonly GatewayAttemptUsage[],
): TokenAggregate | null {
  if (
    attempts.length === 0
    || attempts.some((attempt) => (
      attempt.inputTokens == null
      || attempt.outputTokens == null
      || attempt.totalTokens == null
    ))
  ) {
    return null;
  }
  return attempts.reduce<TokenAggregate>((total, attempt) => ({
    inputTokens: total.inputTokens + attempt.inputTokens!,
    outputTokens: total.outputTokens + attempt.outputTokens!,
    totalTokens: total.totalTokens + attempt.totalTokens!,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
}

export function projectGatewayTurnUsage(input: {
  turnMode: ModelGatewayTurnMode;
  harnessUsage: TokenAggregate | null;
  attempts: readonly GatewayAttemptUsage[];
  settled: boolean;
}): TurnUsage | null {
  const attemptTokens = sumCompleteAttemptTokens(input.attempts);
  const tokens = input.settled && input.turnMode === 'gateway_only'
    ? attemptTokens ?? input.harnessUsage
    : input.harnessUsage ?? attemptTokens;
  if (!tokens) {
    return null;
  }

  const knownAttempts = input.attempts.filter(
    (attempt) => attempt.costState !== 'unpriced',
  );
  const knownUsd = knownAttempts.reduce(
    (sum, attempt) => sum + (attempt.costUsd ?? 0),
    0,
  );
  const hasUnpriced = input.attempts.some(
    (attempt) => attempt.costState === 'unpriced',
  );
  let coverage: TurnUsage['cost']['coverage'];
  if (!input.settled || input.attempts.length === 0) {
    coverage = 'pending';
  } else if (input.turnMode === 'gateway_only' && !hasUnpriced) {
    coverage = 'complete';
  } else if (knownAttempts.length > 0) {
    coverage = 'partial';
  } else {
    coverage = 'unpriced';
  }

  return TurnUsageSchema.parse({
    ...tokens,
    modelCalls: {
      observed: input.attempts.length,
      costKnown: knownAttempts.length,
      expected: null,
    },
    cost: {
      totalUsd: coverage === 'complete' ? knownUsd : null,
      knownUsd,
      coverage,
    },
  });
}
