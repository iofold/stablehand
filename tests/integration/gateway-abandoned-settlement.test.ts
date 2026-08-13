import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { allowConsoleErrors } from '../setup-strict.js';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

/**
 * ctx-qqqp: gateway-attributed turns whose spend evidence never arrives must
 * settle as coverage=unpriced past the abandonment grace — token telemetry
 * preserved, reconciliation stamped — while recent, non-gateway, and
 * already-reconciled turns stay untouched.
 */
describe('settleAbandonedGatewayTurns', () => {
  let testApp: TestAppHandle | undefined;
  let db: TestAppHandle['container']['db'];
  let agentId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({ dirPrefix: 'ctxmill-gw-settle-test-' });
    db = testApp.container.db;
    const createRes = await testApp.app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: `gw-settle-agent-${randomUUID().slice(0, 8)}`,
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'test',
        tools: [],
      },
    });
    expect(createRes.statusCode).toBe(201);
    agentId = createRes.json().id;
  });

  afterAll(async () => {
    await testApp?.close();
  });

  it('settles only abandoned gateway turns, preserving token telemetry', async () => {
    const nowMs = Date.now();
    const oldMs = nowMs - 20 * 60_000;
    const recentMs = nowMs - 60_000;
    const conversation = await db.createConversation(agentId);

    const mkTurn = async (overrides: Record<string, unknown>) => {
      const turn = await db.createTurn({
        id: randomUUID(),
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        status: 'completed',
        gatewayMode: 'gateway_only',
        gatewayProfile: 'default',
        gatewayRevision: 'test-r1',
        gatewayCorrelationId: `ct_${randomUUID().replace(/-/g, '')}`,
        ...overrides,
      } as never);
      return turn.id;
    };

    const lostEvidence = await mkTurn({
      completedAt: oldMs,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        modelCalls: { observed: 1, costKnown: 0, expected: null },
        cost: { totalUsd: null, knownUsd: 0, coverage: 'pending' },
      },
    });
    const erroredNoUsage = await mkTurn({ status: 'error', completedAt: oldMs, usage: null });
    const recentPending = await mkTurn({ completedAt: recentMs });
    const nonGateway = await mkTurn({
      completedAt: oldMs,
      gatewayMode: null,
      gatewayProfile: null,
      gatewayRevision: null,
      gatewayCorrelationId: null,
    });
    const alreadyReconciled = await mkTurn({ completedAt: oldMs, usageReconciledAt: oldMs });

    const settled = await db.settleAbandonedGatewayTurns({
      nowMs,
      abandonedBeforeMs: nowMs - 10 * 60_000,
    });

    // Inclusion, not equality: the shared test database may hold abandoned
    // gateway turns from other suites, and this sweep honestly settles those
    // too.
    const settledIds = settled.map((t) => t.turnId);
    expect(settledIds).toContain(lostEvidence);
    expect(settledIds).toContain(erroredNoUsage);
    expect(settledIds).not.toContain(recentPending);
    expect(settledIds).not.toContain(nonGateway);
    expect(settledIds).not.toContain(alreadyReconciled);

    const lost = await db.getTurn(lostEvidence);
    expect(lost?.usage?.cost).toEqual({ coverage: 'unpriced', knownUsd: 0, totalUsd: null });
    expect(lost?.usage?.totalTokens).toBe(15);
    expect(lost?.usageReconciledAt).toBe(nowMs);

    const errored = await db.getTurn(erroredNoUsage);
    expect(errored?.usage?.cost.coverage).toBe('unpriced');
    expect(errored?.usage?.totalTokens).toBe(0);
    expect(errored?.usageReconciledAt).toBe(nowMs);

    for (const untouched of [recentPending, nonGateway, alreadyReconciled]) {
      const turn = await db.getTurn(untouched);
      expect(turn?.usageReconciledAt === null || turn?.usageReconciledAt === oldMs).toBe(true);
      expect(turn?.usage?.cost?.coverage ?? null).not.toBe('unpriced');
    }
  });
});
