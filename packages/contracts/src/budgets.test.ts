import { describe, expect, it } from 'vitest';

import {
  BudgetPolicyCreateInputSchema,
  BudgetPolicyDocSchema,
  BudgetPolicyPatchInputSchema,
  BudgetSpendResponseSchema,
} from './budgets.js';

const VALID_DOC = {
  selector: { businessUnit: 'finance' },
  groupBy: 'user',
  window: 'rolling-24h',
  limits: {
    totalTokens: 10_000,
    costUsd: 25,
    turns: 20,
  },
  actions: [
    { threshold: 0.8, action: 'warn' },
    { threshold: 1, action: 'block' },
  ],
} as const;

describe('BudgetPolicyDocSchema', () => {
  it('normalizes actions by threshold and accepts the canonical document', () => {
    expect(BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      actions: [...VALID_DOC.actions].reverse(),
    })).toEqual(VALID_DOC);
  });

  it('rejects unknown fields at every policy level', () => {
    expect(() => BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      unknown: true,
    })).toThrow();
    expect(() => BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      limits: { ...VALID_DOC.limits, inputTokens: 10 },
    })).toThrow();
    expect(() => BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      actions: [{ ...VALID_DOC.actions[0], label: 'warn' }],
    })).toThrow();
  });

  it('rejects fractional token and turn limits', () => {
    expect(() => BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      limits: { totalTokens: 1.5 },
    })).toThrow();
    expect(() => BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      limits: { turns: 2.5 },
    })).toThrow();
  });

  it('rejects duplicate actions and warn thresholds at or above block', () => {
    expect(() => BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      actions: [
        { threshold: 0.5, action: 'warn' },
        { threshold: 0.8, action: 'warn' },
      ],
    })).toThrow();
    expect(() => BudgetPolicyDocSchema.parse({
      ...VALID_DOC,
      actions: [
        { threshold: 0.9, action: 'warn' },
        { threshold: 0.8, action: 'block' },
      ],
    })).toThrow();
  });
});

describe('budget API schemas', () => {
  it('requires complete create input and a non-empty strict patch', () => {
    expect(BudgetPolicyCreateInputSchema.parse({
      name: ' Finance cap ',
      doc: VALID_DOC,
    })).toMatchObject({ name: 'Finance cap', enabled: true });
    expect(BudgetPolicyPatchInputSchema.parse({ enabled: false }))
      .toEqual({ enabled: false });
    expect(() => BudgetPolicyPatchInputSchema.parse({})).toThrow();
    expect(() => BudgetPolicyPatchInputSchema.parse({ enabled: false, extra: 1 })).toThrow();
  });

  it('keeps ungrouped, missing-tag, and literal tag bucket identities distinct', () => {
    const base = {
      spend: {
        totalTokens: 0,
        costUsd: null,
        turns: 1,
        tokenReportedTurnCount: 0,
        costReportedTurnCount: 0,
      },
      statuses: [{
        metric: 'turns',
        spent: 1,
        limit: 10,
        ratio: 0.1,
        state: 'ok',
        action: null,
      }],
    };
    const response = BudgetSpendResponseSchema.parse({
      policyId: 'policy-1',
      window: 'rolling-24h',
      windowStart: 1,
      buckets: [
        { ...base, bucket: { kind: 'all' } },
        { ...base, bucket: { kind: 'untagged', key: 'user' } },
        { ...base, bucket: { kind: 'tag', key: 'user', value: '(untagged)' } },
      ],
    });

    expect(response.buckets.map(({ bucket }) => bucket.kind))
      .toEqual(['all', 'untagged', 'tag']);
  });
});
