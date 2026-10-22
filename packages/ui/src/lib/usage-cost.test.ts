import { describe, expect, it } from 'vitest';

import {
  describeConversationCostRollup,
  describeTurnCost,
  formatUsd,
  summarizeTurnCosts,
} from './usage-cost';

const base = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  modelCalls: { observed: 0, costKnown: 0, expected: null },
};

describe('usage cost presentation', () => {
  it('keeps pending, partial, unpriced, and real zero distinct', () => {
    expect(describeTurnCost({
      ...base,
      cost: { totalUsd: null, knownUsd: 0, coverage: 'pending' },
    })).toMatchObject({ label: 'Cost pending', state: 'pending' });
    expect(describeTurnCost({
      ...base,
      cost: { totalUsd: null, knownUsd: 0.2, coverage: 'partial' },
    })).toMatchObject({ label: 'At least $0.2000', state: 'partial' });
    expect(describeTurnCost({
      ...base,
      cost: { totalUsd: null, knownUsd: 0, coverage: 'unpriced' },
    })).toMatchObject({ label: 'Cost not reported', state: 'unpriced' });
    expect(describeTurnCost({
      ...base,
      cost: { totalUsd: 0, knownUsd: 0, coverage: 'complete' },
    })).toMatchObject({ label: '$0.0000', state: 'complete' });
  });

  it('never shows a floor of zero for unpriced conversations', () => {
    expect(describeConversationCostRollup({ knownCostUsd: 0, incompleteCostTurnCount: 1 }))
      .toMatchObject({ label: 'Cost not reported' });
    expect(describeConversationCostRollup({ knownCostUsd: 0.0788, incompleteCostTurnCount: 2 }))
      .toMatchObject({ label: '≥ $0.0788' });
    expect(describeConversationCostRollup({ knownCostUsd: 0.0985, incompleteCostTurnCount: 0 }))
      .toMatchObject({ label: '$0.0985' });
    expect(describeConversationCostRollup({ knownCostUsd: null })).toBeNull();
  });

  it('formats dollars by magnitude', () => {
    expect(formatUsd(0.0788)).toBe('$0.0788');
    expect(formatUsd(12.3456)).toBe('$12.35');
    expect(formatUsd(0.00004)).toBe('$0.000040');
  });

  it('summarizes a conversation without treating missing usage as free', () => {
    expect(summarizeTurnCosts([
      {
        ...base,
        cost: { totalUsd: 0.1, knownUsd: 0.1, coverage: 'complete' },
      },
      null,
    ])).toMatchObject({
      label: 'At least $0.1000',
      state: 'partial',
    });
  });
});
