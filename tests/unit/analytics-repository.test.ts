import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AnalyticsActivityBucket, AnalyticsMetrics } from '@ctxmill/contracts';
import { createTestDb, type TestDb } from '../utils/test-db.js';

interface AnalyticsAgentRow extends AnalyticsMetrics {
  agentId: string;
  name: string;
  harness: string;
  harnessConfig: string;
  lastActivityAt: number | null;
}

interface AnalyticsSnapshot {
  activity: AnalyticsActivityBucket[];
  agents: AnalyticsAgentRow[];
}

describe('analytics repository', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('returns bounded activity buckets and every agent with honest usage coverage', async () => {
    const from = 1_700_000_000_000;
    const bucketSizeMs = 60 * 60 * 1000;
    const to = from + 2 * bucketSizeMs;

    await Promise.all([
      testDb.repo.createAgent({
        id: 'agent-active',
        name: 'Active analyst',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ model: 'gpt-5.4-mini' }),
        systemPrompt: 'Analyze.',
        tools: [],
      }),
      testDb.repo.createAgent({
        id: 'agent-partial',
        name: 'Partial analyst',
        harness: 'pi-agent',
        harnessConfig: JSON.stringify({ model: 'claude-sonnet-4-6' }),
        systemPrompt: 'Analyze.',
        tools: [],
      }),
      testDb.repo.createAgent({
        id: 'agent-idle',
        name: 'Idle analyst',
        harness: 'claude-agents',
        harnessConfig: JSON.stringify({ model: 'claude-haiku-4-5' }),
        systemPrompt: 'Analyze.',
        tools: [],
      }),
    ]);

    await Promise.all([
      testDb.repo.createConversation('agent-active', 'conversation-active'),
      testDb.repo.createConversation('agent-partial', 'conversation-partial'),
    ]);

    await Promise.all([
      testDb.repo.createTurn({
        id: 'turn-complete',
        agentId: 'agent-active',
        conversationId: 'conversation-active',
        status: 'completed',
        startedAt: from + 100,
        completedAt: from + 1_000,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          modelCalls: { observed: 1, costKnown: 1, expected: 1 },
          cost: { totalUsd: 0.01, knownUsd: 0.01, coverage: 'complete' },
        },
      }),
      testDb.repo.createTurn({
        id: 'turn-error',
        agentId: 'agent-active',
        conversationId: 'conversation-active',
        status: 'error',
        startedAt: from + bucketSizeMs + 100,
        completedAt: from + bucketSizeMs + 1_000,
      }),
      testDb.repo.createTurn({
        id: 'turn-partial',
        agentId: 'agent-partial',
        conversationId: 'conversation-partial',
        status: 'completed',
        startedAt: from + bucketSizeMs + 200,
        completedAt: from + bucketSizeMs + 2_000,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
          modelCalls: { observed: 2, costKnown: 1, expected: 2 },
          cost: { totalUsd: null, knownUsd: 0.005, coverage: 'partial' },
        },
      }),
      testDb.repo.createTurn({
        id: 'turn-gateway-pending',
        agentId: 'agent-active',
        conversationId: 'conversation-active',
        status: 'completed',
        startedAt: from + bucketSizeMs + 300,
        completedAt: from + bucketSizeMs + 900,
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
        gatewayMode: 'gateway_only',
      }),
      testDb.repo.createTurn({
        id: 'turn-open',
        agentId: 'agent-active',
        conversationId: 'conversation-active',
        status: 'running',
        startedAt: from + bucketSizeMs + 400,
      }),
      testDb.repo.createTurn({
        id: 'turn-outside-window',
        agentId: 'agent-active',
        conversationId: 'conversation-active',
        status: 'completed',
        startedAt: from - 1,
        completedAt: from,
        inputTokens: 9_999,
        outputTokens: 9_999,
        totalTokens: 19_998,
        costUsd: 99,
      }),
    ]);

    const method = Reflect.get(testDb.repo, 'getAnalyticsSnapshot');
    expect(method).toBeInstanceOf(Function);
    const snapshot = await (
      method as (input: {
        from: number;
        to: number;
        bucketSizeMs: number;
      }) => Promise<AnalyticsSnapshot>
    ).call(testDb.repo, { from, to, bucketSizeMs });

    expect(snapshot.activity).toEqual([
      expect.objectContaining({
        from,
        to: from + bucketSizeMs,
        turns: 1,
        completedTurns: 1,
        totalTokens: 150,
        tokenReportedTurns: 1,
        knownCostUsd: 0.01,
        costCoverage: {
          complete: 1,
          partial: 0,
          pending: 0,
          unpriced: 0,
        },
      }),
      expect.objectContaining({
        from: from + bucketSizeMs,
        to,
        turns: 4,
        completedTurns: 2,
        errorTurns: 1,
        activeTurns: 1,
        totalTokens: 70,
        tokenReportedTurns: 2,
        knownCostUsd: 0.005,
        // Gateway-attributed and still-open turns await cost data; a terminal
        // direct turn without cost will never be priced and reads unpriced.
        costCoverage: {
          complete: 0,
          partial: 1,
          pending: 2,
          unpriced: 1,
        },
      }),
    ]);
    expect(snapshot.agents.map(({ agentId }) => agentId)).toEqual([
      'agent-active',
      'agent-partial',
      'agent-idle',
    ]);
    expect(snapshot.agents[0]).toMatchObject({
      turns: 4,
      completedTurns: 2,
      errorTurns: 1,
      activeTurns: 1,
      totalTokens: 190,
      knownCostUsd: 0.01,
      lastActivityAt: from + bucketSizeMs + 1_000,
      costCoverage: {
        complete: 1,
        partial: 0,
        pending: 2,
        unpriced: 1,
      },
    });
    expect(snapshot.agents[1]).toMatchObject({
      turns: 1,
      totalTokens: 30,
      knownCostUsd: 0.005,
      costCoverage: {
        complete: 0,
        partial: 1,
        pending: 0,
        unpriced: 0,
      },
    });
    expect(snapshot.agents[2]).toMatchObject({
      turns: 0,
      totalTokens: 0,
      knownCostUsd: 0,
      lastActivityAt: null,
      costCoverage: {
        complete: 0,
        partial: 0,
        pending: 0,
        unpriced: 0,
      },
    });
  });
});
