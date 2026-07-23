import { describe, expect, it } from 'vitest';

import { materializeTurnUsage } from '../usage.js';

describe('materializeTurnUsage', () => {
  it('materializes complete reported aggregate cost without inventing call counts', () => {
    expect(materializeTurnUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: 0.02,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelCalls: {
        observed: 0,
        costKnown: 0,
        expected: null,
      },
      cost: {
        totalUsd: 0.02,
        knownUsd: 0.02,
        coverage: 'complete',
      },
    });
  });

  it('marks token-bearing usage without cost as unpriced rather than free', () => {
    expect(materializeTurnUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    })?.cost).toEqual({
      totalUsd: null,
      knownUsd: 0,
      coverage: 'unpriced',
    });
  });

  it('returns null for absent or incomplete token aggregates', () => {
    expect(materializeTurnUsage(null)).toBeNull();
    expect(materializeTurnUsage({
      inputTokens: null,
      outputTokens: 5,
      totalTokens: 15,
      costUsd: null,
    })).toBeNull();
  });
});
