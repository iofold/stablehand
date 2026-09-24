import Fastify from 'fastify';
import {
  AgentBudgetStatusListResponseSchema,
  BudgetPolicyListResponseSchema,
  BudgetPolicySchema,
  BudgetSpendResponseSchema,
} from '@stablehand/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { budgetRoutes } from '../budgets.js';

const DOC = {
  selector: {},
  groupBy: 'user',
  window: 'rolling-24h',
  limits: { totalTokens: 1000 },
  actions: [
    { threshold: 0.8, action: 'warn' },
    { threshold: 1, action: 'block' },
  ],
} as const;

function policy(doc: unknown = DOC) {
  return {
    id: 'policy-1',
    name: 'Finance cap',
    enabled: true,
    doc,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function createApp(overrides: Record<string, unknown> = {}) {
  const db = {
    listBudgetPolicies: vi.fn().mockResolvedValue([policy()]),
    getBudgetPolicy: vi.fn().mockResolvedValue(policy()),
    createBudgetPolicy: vi.fn().mockImplementation(async (input) => policy(input.doc)),
    updateBudgetPolicy: vi.fn().mockImplementation(async (_id, input) => ({
      ...policy(),
      ...input,
    })),
    deleteBudgetPolicy: vi.fn().mockResolvedValue(true),
    getBudgetSpend: vi.fn().mockResolvedValue({
      totalTokens: 0,
      costUsd: null,
      turns: 0,
      tokenReportedTurnCount: 0,
      costReportedTurnCount: 0,
    }),
    getBudgetSpendBuckets: vi.fn().mockResolvedValue([{
      bucket: '(untagged)',
      totalTokens: 25,
      costUsd: null,
      turns: 1,
      tokenReportedTurnCount: 1,
      costReportedTurnCount: 0,
    }, {
      bucket: null,
      totalTokens: null,
      costUsd: null,
      turns: 1,
      tokenReportedTurnCount: 0,
      costReportedTurnCount: 0,
    }]),
    listAgents: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  const app = Fastify({ logger: false });
  await app.register(budgetRoutes, { prefix: '/api/budgets', db: db as never });
  return { app, db };
}

describe('budget routes', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>['app']> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('contract-parses list and individual policy responses', async () => {
    const { app } = await createApp();
    apps.push(app);

    const list = await app.inject({ method: 'GET', url: '/api/budgets' });
    const one = await app.inject({ method: 'GET', url: '/api/budgets/policy-1' });

    expect(BudgetPolicyListResponseSchema.parse(list.json()).policies).toHaveLength(1);
    expect(BudgetPolicySchema.parse(one.json()).id).toBe('policy-1');
  });

  it('persists normalized create input and exposes PATCH without legacy PUT', async () => {
    const { app, db } = await createApp();
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        name: ' Finance cap ',
        doc: {
          ...DOC,
          actions: [...DOC.actions].reverse(),
        },
      },
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/budgets/policy-1',
      payload: { enabled: false },
    });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/budgets/policy-1',
      payload: { enabled: false },
    });

    expect(created.statusCode).toBe(201);
    expect(db.createBudgetPolicy).toHaveBeenCalledWith({
      name: 'Finance cap',
      enabled: true,
      doc: DOC,
    });
    expect(patched.statusCode).toBe(200);
    expect(put.statusCode).toBe(404);
  });

  it('rejects unknown fields rather than silently storing them', async () => {
    const { app, db } = await createApp();
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/budgets',
      payload: {
        name: 'Finance cap',
        doc: { ...DOC, unexpected: true },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(db.createBudgetPolicy).not.toHaveBeenCalled();
  });

  it('returns structured buckets so a literal sentinel value cannot collide', async () => {
    const { app } = await createApp();
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/budgets/policy-1/spend',
    });
    const spend = BudgetSpendResponseSchema.parse(response.json());

    expect(spend.buckets.map(({ bucket }) => bucket)).toEqual([
      { kind: 'tag', key: 'user', value: '(untagged)' },
      { kind: 'untagged', key: 'user' },
    ]);
  });

  it('returns one server-derived current budget status per agent', async () => {
    const { app, db } = await createApp({
      listBudgetPolicies: vi.fn().mockResolvedValue([policy({
        selector: {},
        window: 'rolling-24h',
        limits: { totalTokens: 100 },
        actions: [{ threshold: 0.8, action: 'warn' }],
      })]),
      listAgents: vi.fn().mockResolvedValue([{
        id: 'agent-1',
        harness: 'langgraph',
        metadata: null,
      }, {
        id: 'agent-2',
        harness: 'claude-agents',
        metadata: null,
      }]),
      getBudgetSpend: vi.fn().mockImplementation(async (selector) => ({
        totalTokens: selector.agent === 'agent-1' ? 90 : 10,
        costUsd: null,
        turns: 1,
        tokenReportedTurnCount: 1,
        costReportedTurnCount: 0,
      })),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/budgets/agents/status',
    });
    const parsed = AgentBudgetStatusListResponseSchema.parse(response.json());
    expect(parsed.statuses.map(({ agentId, state }) => ({ agentId, state })))
      .toEqual([
        { agentId: 'agent-1', state: 'warning' },
        { agentId: 'agent-2', state: 'ok' },
      ]);
    expect(db.getBudgetSpend).toHaveBeenCalledWith(
      { agent: 'agent-1' },
      expect.any(Number),
    );
  });
});
