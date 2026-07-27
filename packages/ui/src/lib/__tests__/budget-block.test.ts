import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import { describeBudgetBlock, parseBudgetBlock } from '../budget-block';

const blockBody = {
  error: 'Budget exceeded',
  code: 'budget_exceeded',
  policyId: 'policy-1',
  policyName: 'Growth team cap',
  bucket: { kind: 'tag', key: 'team', value: 'growth' },
  metric: 'costUsd',
  spent: 12.5,
  limit: 10,
};

describe('parseBudgetBlock', () => {
  it('recognizes a structured budget_exceeded 429', () => {
    const err = new ApiError('API POST /x failed: 429', 429, blockBody);
    expect(parseBudgetBlock(err)?.policyName).toBe('Growth team cap');
  });

  it('ignores other errors and malformed bodies', () => {
    expect(parseBudgetBlock(new Error('boom'))).toBeNull();
    expect(parseBudgetBlock(new ApiError('x', 500, blockBody))).toBeNull();
    expect(parseBudgetBlock(new ApiError('x', 429, { error: 'rate limited' }))).toBeNull();
  });
});

describe('describeBudgetBlock', () => {
  it('names the policy and formats the tripped metric', () => {
    const described = describeBudgetBlock(parseBudgetBlock(
      new ApiError('x', 429, blockBody),
    )!);
    expect(described.summary).toBe('Run blocked by the "Growth team cap" budget');
    expect(described.detail).toBe(
      '$12.50 of the $10.00 spend limit for team=growth is already used this window.',
    );
  });

  it('formats token metrics without dollar signs', () => {
    const described = describeBudgetBlock(describeInput({
      metric: 'totalTokens',
      spent: 120000,
      limit: 100000,
      bucket: { kind: 'all' },
    }));
    expect(described.detail).toBe(
      `${(120000).toLocaleString()} of the ${(100000).toLocaleString()} tokens limit is already used this window.`,
    );
  });
});

function describeInput(overrides: Record<string, unknown>) {
  const err = new ApiError('x', 429, { ...blockBody, ...overrides });
  const parsed = parseBudgetBlock(err);
  if (!parsed) throw new Error('fixture should parse');
  return parsed;
}
