import { describe, expect, it } from 'vitest';

import { describeTurnCost, summarizeTurnCosts } from './usage-cost';

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
    })).toMatchObject({ label: 'Cost unavailable', state: 'unpriced' });
    expect(describeTurnCost({
      ...base,
      cost: { totalUsd: 0, knownUsd: 0, coverage: 'complete' },
    })).toMatchObject({ label: '$0.0000', state: 'complete' });
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
