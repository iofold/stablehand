import { describe, expect, it, vi } from 'vitest';

import {
  BudgetExceededError,
  TagNotProvisionedError,
  UNTAGGED_BUCKET,
  metricStatuses,
  parseBudgetPolicyDoc,
  selectorMatches,
  trippedAction,
  windowStartMs,
} from '../budgets.js';
import { BudgetEnforcer } from '../budget-enforcer.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const VALID_DOC = {
  selector: { bu: 'finance' },
  groupBy: 'user',
  window: 'rolling-24h',
  limits: { totalTokens: 1000 },
  actions: [
    { threshold: 0.8, action: 'warn' },
    { threshold: 1, action: 'block' },
  ],
};

describe('parseBudgetPolicyDoc', () => {
  it('accepts a full valid doc', () => {
    const parsed = parseBudgetPolicyDoc(VALID_DOC);
    expect('doc' in parsed && parsed.doc.groupBy).toBe('user');
  });

  it('rejects unknown windows, empty limits, and out-of-range thresholds', () => {
    expect(parseBudgetPolicyDoc({ ...VALID_DOC, window: 'weekly' })).toHaveProperty('error');
    expect(parseBudgetPolicyDoc({ ...VALID_DOC, limits: {} })).toHaveProperty('error');
    expect(parseBudgetPolicyDoc({
      ...VALID_DOC,
      actions: [{ threshold: 1.5, action: 'block' }],
    })).toHaveProperty('error');
    expect(parseBudgetPolicyDoc({ ...VALID_DOC, selector: { bu: 42 } })).toHaveProperty('error');
  });

  it('rejects drift-prone unknown, fractional, duplicate, and reversed values', () => {
    expect(parseBudgetPolicyDoc({ ...VALID_DOC, unknown: true })).toHaveProperty('error');
    expect(parseBudgetPolicyDoc({
      ...VALID_DOC,
      limits: { totalTokens: 1.5 },
    })).toHaveProperty('error');
    expect(parseBudgetPolicyDoc({
      ...VALID_DOC,
      actions: [
        { threshold: 0.7, action: 'warn' },
        { threshold: 0.7, action: 'warn' },
      ],
    })).toHaveProperty('error');
    // Several distinct warn thresholds are fine (e.g. 50% and 85% alerts).
    expect(parseBudgetPolicyDoc({
      ...VALID_DOC,
      actions: [
        { threshold: 0.5, action: 'warn' },
        { threshold: 0.7, action: 'warn' },
      ],
    })).toHaveProperty('doc');
    expect(parseBudgetPolicyDoc({
      ...VALID_DOC,
      actions: [
        { threshold: 0.9, action: 'warn' },
        { threshold: 0.8, action: 'block' },
      ],
    })).toHaveProperty('error');
  });
});

describe('windowStartMs', () => {
  it('computes month-to-date in UTC (2026-07-15 decision)', () => {
    // 2026-07-01T05:30:00Z: in UTC the month starts July 1; in IST (+5:30)
    // the local date is already July 1 11:00 — UTC must win.
    const now = Date.UTC(2026, 6, 1, 5, 30);
    expect(windowStartMs('month-to-date', now)).toBe(Date.UTC(2026, 6, 1));
    // Just before UTC midnight on June 30, the window still starts June 1.
    const beforeMidnight = Date.UTC(2026, 5, 30, 23, 59);
    expect(windowStartMs('month-to-date', beforeMidnight)).toBe(Date.UTC(2026, 5, 1));
  });

  it('computes rolling windows', () => {
    const now = 1_000_000_000_000;
    expect(windowStartMs('rolling-24h', now)).toBe(now - 24 * 3600 * 1000);
    expect(windowStartMs('rolling-1h', now)).toBe(now - 3600 * 1000);
  });
});

describe('selector and metrics', () => {
  it('matches on subset equality; empty selector matches everything', () => {
    expect(selectorMatches({}, { anything: 'x' })).toBe(true);
    expect(selectorMatches({ bu: 'finance' }, { bu: 'finance', user: 'a' })).toBe(true);
    expect(selectorMatches({ bu: 'finance' }, { bu: 'sales' })).toBe(false);
    expect(selectorMatches({ bu: 'finance' }, {})).toBe(false);
  });

  it('trips the highest crossed threshold across metrics', () => {
    const doc = parseBudgetPolicyDoc({
      ...VALID_DOC,
      limits: { totalTokens: 1000, turns: 10 },
    });
    if (!('doc' in doc)) throw new Error('doc invalid');

    const warn = trippedAction(doc.doc, { totalTokens: 850, costUsd: 0, turns: 2 });
    expect(warn?.action.action).toBe('warn');

    // turns metric hits the block threshold even though tokens are low.
    const block = trippedAction(doc.doc, { totalTokens: 10, costUsd: 0, turns: 10 });
    expect(block?.action.action).toBe('block');
    expect(block?.status.metric).toBe('turns');

    expect(trippedAction(doc.doc, { totalTokens: 100, costUsd: 0, turns: 1 })).toBeUndefined();
    expect(metricStatuses(doc.doc.limits, { totalTokens: 500, costUsd: 0, turns: 5 })[0]?.ratio).toBe(0.5);
  });
});

describe('BudgetEnforcer.checkAdmission', () => {
  function makeDb(overrides: Partial<{
    policies: Array<{ id: string; name: string; enabled: boolean; doc: unknown }>;
    spend: { totalTokens: number; costUsd: number; turns: number };
  }> = {}) {
    return {
      listBudgetPolicies: vi.fn().mockResolvedValue(
        overrides.policies ?? [{ id: 'p1', name: 'finance cap', enabled: true, doc: VALID_DOC }],
      ),
      getBudgetSpend: vi.fn().mockResolvedValue(
        overrides.spend ?? { totalTokens: 0, costUsd: 0, turns: 0 },
      ),
      getTurn: vi.fn(),
    };
  }

  const PROVISIONED = { user: ['alice@acme.com'] };

  it('admits when spend is under every threshold', async () => {
    const db = makeDb({ spend: { totalTokens: 100, costUsd: 0, turns: 1 } });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });
    await expect(enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance', user: 'alice@acme.com' },
      budgetDimensions: PROVISIONED,
    })).resolves.toBeUndefined();
    expect(db.getBudgetSpend).toHaveBeenCalledWith(
      { bu: 'finance' },
      expect.any(Number),
      { key: 'user', value: 'alice@acme.com' },
    );
  });

  it('blocks when the bucket is exhausted', async () => {
    const db = makeDb({ spend: { totalTokens: 1000, costUsd: 0, turns: 3 } });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });
    await expect(enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance', user: 'alice@acme.com' },
      budgetDimensions: PROVISIONED,
    })).rejects.toThrow(BudgetExceededError);
  });

  it('blocks whenever block is crossed regardless of input action order', async () => {
    const db = makeDb({
      policies: [{
        id: 'p1',
        name: 'finance cap',
        enabled: true,
        doc: {
          ...VALID_DOC,
          actions: [
            { threshold: 1, action: 'block' },
            { threshold: 0.8, action: 'warn' },
          ],
        },
      }],
      spend: { totalTokens: 1000, costUsd: 0, turns: 3 },
    });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });
    await expect(enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance', user: 'alice@acme.com' },
      budgetDimensions: PROVISIONED,
    })).rejects.toThrow(BudgetExceededError);
  });

  it('skips policies whose selector does not match', async () => {
    const db = makeDb({ spend: { totalTokens: 99999, costUsd: 0, turns: 999 } });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });
    await expect(enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'sales' },
      budgetDimensions: {},
    })).resolves.toBeUndefined();
    expect(db.getBudgetSpend).not.toHaveBeenCalled();
  });

  it('rejects groupBy tag values the agent has not pre-provisioned', async () => {
    const enforcer = new BudgetEnforcer({ db: makeDb() as never, logger: silentLogger });
    await expect(enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance', user: 'mallory@evil.com' },
      budgetDimensions: PROVISIONED,
    })).rejects.toThrow(TagNotProvisionedError);
    // Missing dimension list entirely is also a rejection.
    await expect(enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance', user: 'alice@acme.com' },
      budgetDimensions: {},
    })).rejects.toThrow(TagNotProvisionedError);
  });

  it('routes tag-less runs into the untagged bucket instead of rejecting', async () => {
    const db = makeDb({ spend: { totalTokens: 1000, costUsd: 0, turns: 1 } });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });
    const err = await enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance' },
      budgetDimensions: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).bucket).toBe(UNTAGGED_BUCKET);
    expect(db.getBudgetSpend).toHaveBeenCalledWith(
      { bu: 'finance' },
      expect.any(Number),
      { key: 'user', value: null },
    );
  });

  it('fails open when the policy list or spend query errors', async () => {
    const brokenList = {
      listBudgetPolicies: vi.fn().mockRejectedValue(new Error('db down')),
      getBudgetSpend: vi.fn(),
      getTurn: vi.fn(),
    };
    const enforcer = new BudgetEnforcer({ db: brokenList as never, logger: silentLogger });
    await expect(enforcer.checkAdmission({ agentId: 'a1', tags: {}, budgetDimensions: {} }))
      .resolves.toBeUndefined();

    const brokenSpend = makeDb();
    brokenSpend.getBudgetSpend.mockRejectedValue(new Error('query timeout'));
    const enforcer2 = new BudgetEnforcer({ db: brokenSpend as never, logger: silentLogger });
    await expect(enforcer2.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance', user: 'alice@acme.com' },
      budgetDimensions: PROVISIONED,
    })).resolves.toBeUndefined();
  });

  it('skips disabled and invalid policies', async () => {
    const db = makeDb({
      policies: [
        { id: 'p1', name: 'off', enabled: false, doc: VALID_DOC },
        { id: 'p2', name: 'broken', enabled: true, doc: { selector: {} } },
      ],
      spend: { totalTokens: 999999, costUsd: 0, turns: 9999 },
    });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });
    await expect(enforcer.checkAdmission({
      agentId: 'a1',
      tags: { bu: 'finance', user: 'alice@acme.com' },
      budgetDimensions: PROVISIONED,
    })).resolves.toBeUndefined();
  });
});

describe('BudgetEnforcer.onTurnCompleted', () => {
  it('emits budget.threshold only when this turn crossed the threshold', async () => {
    const db = {
      listBudgetPolicies: vi.fn().mockResolvedValue([
        { id: 'p1', name: 'finance cap', enabled: true, doc: { ...VALID_DOC, groupBy: undefined } },
      ]),
      // After this turn: 850/1000 → warn threshold (0.8) crossed by a
      // 100-token contribution (before = 750 < 800 <= 850).
      getBudgetSpend: vi.fn().mockResolvedValue({ totalTokens: 850, costUsd: 0, turns: 5 }),
      getTurn: vi.fn().mockResolvedValue({ id: 't1', tags: { bu: 'finance' } }),
    };
    const emit = vi.fn();
    const enforcer = new BudgetEnforcer({ db: db as never, eventBus: { emit } as never, logger: silentLogger });

    await enforcer.onTurnCompleted({
      turnId: 't1', sandboxSessionId: 's1', agentId: 'a1', conversationId: 'c1',
      status: 'completed', durationMs: 10,
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        modelCalls: { observed: 1, costKnown: 0, expected: 1 },
        cost: { totalUsd: null, knownUsd: 0, coverage: 'unpriced' },
      },
      timestamp: Date.now(),
    });
    expect(emit).toHaveBeenCalledWith('budget.threshold', expect.objectContaining({
      policyId: 'p1',
      action: 'warn',
      metric: 'totalTokens',
      spent: 850,
      limit: 1000,
    }));

    // Same spend, tiny contribution that did not cross: no event.
    emit.mockClear();
    await enforcer.onTurnCompleted({
      turnId: 't1', sandboxSessionId: 's1', agentId: 'a1', conversationId: 'c1',
      status: 'completed', durationMs: 10,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        modelCalls: { observed: 1, costKnown: 0, expected: 1 },
        cost: { totalUsd: null, knownUsd: 0, coverage: 'unpriced' },
      },
      timestamp: Date.now(),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('evaluates only the late usage delta when gateway cost is reconciled', async () => {
    const db = {
      listBudgetPolicies: vi.fn().mockResolvedValue([{
        id: 'p-cost',
        name: 'gateway cost cap',
        enabled: true,
        doc: {
          selector: { bu: 'finance' },
          window: 'rolling-24h',
          limits: { costUsd: 10 },
          actions: [{ threshold: 0.8, action: 'warn' }],
        },
      }]),
      getBudgetSpend: vi.fn().mockResolvedValue({
        totalTokens: 500,
        costUsd: 8.25,
        turns: 5,
      }),
      getTurn: vi.fn().mockResolvedValue({
        id: 't1',
        tags: { bu: 'finance' },
      }),
    };
    const emit = vi.fn();
    const enforcer = new BudgetEnforcer({
      db: db as never,
      eventBus: { emit } as never,
      logger: silentLogger,
    });

    await enforcer.onTurnUsageReconciled({
      turnId: 't1',
      agentId: 'a1',
      previousUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        modelCalls: { observed: 0, costKnown: 0, expected: null },
        cost: { totalUsd: null, knownUsd: 0, coverage: 'pending' },
      },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        modelCalls: { observed: 0, costKnown: 0, expected: null },
        cost: { totalUsd: 0.5, knownUsd: 0.5, coverage: 'complete' },
      },
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('budget.threshold', expect.objectContaining({
      policyId: 'p-cost',
      metric: 'costUsd',
      spent: 8.25,
      limit: 10,
    }));
  });
});

describe('BudgetEnforcer.costHeadroom', () => {
  const COST_DOC = {
    selector: { team: 'growth' },
    window: 'month-to-date',
    limits: { costUsd: 10 },
    actions: [{ threshold: 0.9, action: 'block' }],
  };

  function makeDb(
    policies: Array<{ id: string; name: string; enabled: boolean; doc: unknown }>,
    spendByPolicy: Record<string, { totalTokens: number | null; costUsd: number | null; turns: number }>,
  ) {
    const selectorToPolicy = new Map(policies.map((policy) => [
      JSON.stringify((policy.doc as { selector?: unknown }).selector),
      policy.id,
    ]));
    return {
      listBudgetPolicies: vi.fn().mockResolvedValue(policies),
      getBudgetSpend: vi.fn(async (selector: Record<string, string>) => {
        const policyId = selectorToPolicy.get(JSON.stringify(selector));
        const spend = policyId ? spendByPolicy[policyId] : undefined;
        if (!spend) throw new Error('unexpected spend query');
        return spend;
      }),
      getTurn: vi.fn(),
    };
  }

  it('returns what is left before the block threshold of the tightest cost policy', async () => {
    const db = makeDb([
      { id: 'p1', name: 'Growth team', enabled: true, doc: COST_DOC },
      {
        id: 'p2',
        name: 'Everyone',
        enabled: true,
        doc: { ...COST_DOC, selector: {}, limits: { costUsd: 100 } },
      },
    ], {
      p1: { totalTokens: 1, costUsd: 8.5, turns: 4 },
      p2: { totalTokens: 1, costUsd: 20, turns: 9 },
    });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });

    const headroom = await enforcer.costHeadroom({ team: 'growth' });

    expect(headroom).toEqual({
      remainingUsd: expect.closeTo(0.5, 10),
      limitUsd: 9,
      spentUsd: 8.5,
      policyId: 'p1',
      policyName: 'Growth team',
    });
  });

  it('ignores warn-only, token-only, unpriced and unreadable policies (fail-open)', async () => {
    const db = makeDb([
      { id: 'warn', name: 'warn only', enabled: true, doc: { ...COST_DOC, selector: { a: '1' }, actions: [{ threshold: 0.5, action: 'warn' }] } },
      { id: 'tokens', name: 'tokens', enabled: true, doc: { ...VALID_DOC, selector: { b: '1' }, groupBy: undefined } },
      { id: 'unpriced', name: 'unpriced', enabled: true, doc: { ...COST_DOC, selector: { c: '1' } } },
      { id: 'broken', name: 'broken', enabled: true, doc: { ...COST_DOC, selector: { d: '1' } } },
    ], {
      unpriced: { totalTokens: 10, costUsd: null, turns: 1 },
    });
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });

    await expect(enforcer.costHeadroom({ a: '1', b: '1', c: '1', d: '1' })).resolves.toBeNull();
  });

  it('never reports negative headroom', async () => {
    const db = makeDb(
      [{ id: 'p1', name: 'Growth team', enabled: true, doc: COST_DOC }],
      { p1: { totalTokens: 1, costUsd: 12, turns: 4 } },
    );
    const enforcer = new BudgetEnforcer({ db: db as never, logger: silentLogger });

    await expect(enforcer.costHeadroom({ team: 'growth' })).resolves.toMatchObject({ remainingUsd: 0 });
  });
});
