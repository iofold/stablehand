import type { TurnUsage } from '@ctxmill/contracts';

export type UsageCostState =
  | 'unavailable'
  | TurnUsage['cost']['coverage'];

export interface UsageCostDescription {
  label: string;
  title: string;
  state: UsageCostState;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function describeTurnCost(
  usage: TurnUsage | null | undefined,
): UsageCostDescription {
  if (!usage) {
    return {
      label: 'Usage unavailable',
      title: 'This turn did not report trustworthy usage.',
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
      title: 'The model gateway has not finished reconciling this turn.',
      state: 'pending',
    };
  }
  if (usage.cost.coverage === 'partial') {
    return {
      label: `At least ${usd(usage.cost.knownUsd)}`,
      title: 'Some model-call cost is known; the full turn is not priced.',
      state: 'partial',
    };
  }
  return {
    label: 'Cost unavailable',
    title: 'Model calls occurred, but no trustworthy cost was reported.',
    state: 'unpriced',
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
    label: 'Cost unavailable',
    title: 'The conversation has no trustworthy model cost total.',
    state: 'unpriced',
  };
}
