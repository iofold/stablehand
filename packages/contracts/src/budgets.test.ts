import { describe, expect, it } from 'vitest';

import {
  BudgetPolicyCreateInputSchema,
  BudgetPolicyDocSchema,
  BudgetPolicyPatchInputSchema,
  BudgetSpendResponseSchema,
  TurnStopReasonSchema,
  describeTurnStopReason,
  formatSpendUsd,
  turnStopReasonMessage,
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

describe('turn stop reasons', () => {
  it('accepts the two typed stops and rejects unknown codes or fields', () => {
    expect(TurnStopReasonSchema.parse({
      code: 'budget_reached',
      source: 'run_limit',
      capUsd: 0.05,
      spentUsd: 0.0512,
    })).toMatchObject({ code: 'budget_reached' });
    expect(TurnStopReasonSchema.parse({
      code: 'model_gateway_budget_exceeded',
      spentUsd: null,
      limitUsd: null,
    })).toMatchObject({ code: 'model_gateway_budget_exceeded' });
    expect(() => TurnStopReasonSchema.parse({ code: 'budget_exceeded' })).toThrow();
    expect(() => TurnStopReasonSchema.parse({
      code: 'budget_reached',
      source: 'run_limit',
      capUsd: 1,
      spentUsd: null,
      apiKey: 'nope',
    })).toThrow();
  });

  it('formats small and ordinary dollar amounts readably', () => {
    expect(formatSpendUsd(0.05)).toBe('$0.05');
    expect(formatSpendUsd(12.5)).toBe('$12.50');
    expect(formatSpendUsd(0.0012)).toBe('$0.0012');
    expect(formatSpendUsd(0.5)).toBe('$0.50');
    expect(formatSpendUsd(0.0567103)).toBe('$0.0567');
    expect(formatSpendUsd(0.1)).toBe('$0.10');
    expect(formatSpendUsd(0.125)).toBe('$0.125');
    expect(formatSpendUsd(0.000053)).toBe('$0.000053');
    expect(formatSpendUsd(0.00000004)).toBe('<$0.000001');
    expect(formatSpendUsd(0)).toBe('$0');
  });

  it('describes a per-run cap stop by its consequence', () => {
    expect(describeTurnStopReason({
      code: 'budget_reached',
      source: 'run_limit',
      capUsd: 0.05,
      spentUsd: 0.0512,
    })).toEqual({
      summary: 'Stopped: this run reached its $0.05 spend cap',
      detail: 'It had spent $0.0512. The cap is this agent\'s per-run spend limit.',
    });
  });

  it('names the budget whose remaining headroom capped the run', () => {
    expect(turnStopReasonMessage({
      code: 'budget_reached',
      source: 'budget_policy',
      capUsd: 1.25,
      spentUsd: null,
      policyName: 'Growth team',
      bucket: 'team=growth',
    })).toBe(
      'Stopped: this run reached its $1.25 spend cap. That was what remained of the "Growth team" budget for team=growth when the run started.',
    );
  });

  it('attributes a gateway ceiling to the gateway, never to a Stablehand budget', () => {
    const { summary, detail } = describeTurnStopReason({
      code: 'model_gateway_budget_exceeded',
      spentUsd: 100.2,
      limitUsd: 100,
    });
    expect(summary).toBe('Stopped: the model gateway refused further model calls for budget');
    expect(detail).toContain('($100.20 of $100.00)');
    expect(detail).not.toMatch(/policy|"/);
  });
});
