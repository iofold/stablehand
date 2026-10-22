import type { TurnUsage } from '@stablehand/contracts';

export type UsageCostState =
  | 'unavailable'
  | TurnUsage['cost']['coverage'];

export interface UsageCostDescription {
  label: string;
  title: string;
  state: UsageCostState;
}

/**
 * Dollar amounts for model cost: four decimals under $1 (turns cost cents),
 * two from there, and two significant digits for sub-cent-hundredths.
 */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return `$${value.toPrecision(2)}`;
  const decimals = Math.abs(value) >= 1 ? 2 : 4;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

const usd = formatUsd;

/** Shown wherever a cost cannot be stated because no price was reported. */
export const COST_NOT_REPORTED = 'Cost not reported';

function callCoverageNote(usage: TurnUsage): string {
  if (usage.modelCalls.observed === 0) return '';
  return ` ${usage.modelCalls.costKnown} of ${usage.modelCalls.observed} model calls priced.`;
}

export function describeTurnCost(
  usage: TurnUsage | null | undefined,
): UsageCostDescription {
  if (!usage) {
    return {
      label: 'Usage not reported',
      title: 'This turn did not report token usage or cost.',
      state: 'unavailable',
    };
  }
  if (usage.cost.coverage === 'complete') {
    return {
      label: usd(usage.cost.totalUsd!),
      title: 'Complete model cost coverage.',
      state: 'complete',
    };
  }
  if (usage.cost.coverage === 'pending') {
    return {
      label: usage.cost.knownUsd > 0
        ? `Cost pending · ${usd(usage.cost.knownUsd)} known`
        : 'Cost pending',
      title: `Cost data for this turn is still syncing from the model gateway.${callCoverageNote(usage)}`,
      state: 'pending',
    };
  }
  if (usage.cost.coverage === 'partial') {
    return {
      label: `At least ${usd(usage.cost.knownUsd)}`,
      title: `Some model-call cost is known; the full turn is not priced.${callCoverageNote(usage)}`,
      state: 'partial',
    };
  }
  return {
    label: COST_NOT_REPORTED,
    title: `No price is configured for this model, so this turn's cost is not counted.${callCoverageNote(usage)}`,
    state: 'unpriced',
  };
}

/**
 * Label a conversation-summary cost rollup. Null when the conversation has no
 * cost data at all — callers should render nothing rather than $0.
 */
export function describeConversationCostRollup(summary: {
  knownCostUsd?: number | null;
  incompleteCostTurnCount?: number;
}): { label: string; title: string } | null {
  if (summary.knownCostUsd == null) return null;
  const incomplete = summary.incompleteCostTurnCount ?? 0;
  const turns = `${incomplete} ${incomplete === 1 ? 'turn has' : 'turns have'}`;
  if (incomplete > 0 && summary.knownCostUsd === 0) {
    return {
      label: COST_NOT_REPORTED,
      title: `${turns} no reported cost.`,
    };
  }
  if (incomplete > 0) {
    return {
      label: `≥ ${usd(summary.knownCostUsd)}`,
      title: `${turns} no reported cost, so the total is at least this much.`,
    };
  }
  return {
    label: usd(summary.knownCostUsd),
    title: 'All turns in this conversation are fully priced.',
  };
}

export function summarizeTurnCosts(
  usages: ReadonlyArray<TurnUsage | null | undefined>,
): UsageCostDescription {
  if (usages.length === 0 || usages.every((usage) => usage == null)) {
    return describeTurnCost(null);
  }
  const reported = usages.filter((usage): usage is TurnUsage => usage != null);
  const knownUsd = reported.reduce(
    (sum, usage) => sum + usage.cost.knownUsd,
    0,
  );
  if (reported.some((usage) => usage.cost.coverage === 'pending')) {
    return {
      label: knownUsd > 0
        ? `Cost pending · ${usd(knownUsd)} known`
        : 'Cost pending',
      title: 'At least one turn is still awaiting model cost reconciliation.',
      state: 'pending',
    };
  }
  if (
    reported.length === usages.length
    && reported.every((usage) => usage.cost.coverage === 'complete')
  ) {
    return {
      label: usd(knownUsd),
      title: 'Complete model cost coverage for every turn.',
      state: 'complete',
    };
  }
  if (knownUsd > 0) {
    return {
      label: `At least ${usd(knownUsd)}`,
      title: 'The conversation contains partial or missing model cost coverage.',
      state: 'partial',
    };
  }
  return {
    label: COST_NOT_REPORTED,
    title: 'No turn in this conversation reported a model cost.',
    state: 'unpriced',
  };
}
