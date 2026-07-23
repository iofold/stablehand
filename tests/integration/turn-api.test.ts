import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { allowConsoleErrors } from '../setup-strict.js';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

describe('Turn API lifecycle', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;
  let agentId: string;
  let restoreTurnLaunch: (() => void) | undefined;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'ctxmill-session-test-',
    });
    app = testApp.app;
    container = testApp.container;
    const turnLaunch = vi
      .spyOn(container.turnStartupService, 'launchPreparedTurn')
      .mockResolvedValue(undefined);
    restoreTurnLaunch = () => turnLaunch.mockRestore();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'session-test-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'You are a test agent.',
        tools: [],
      },
    });
    expect(createRes.statusCode).toBe(201);
    agentId = createRes.json().id;
  });

  afterAll(async () => {
    restoreTurnLaunch?.();
    await testApp?.close();
  });

  it('GET /api/agents/:id/turns returns persisted turns under a turn-named contract', async () => {
    const firstConversation = await container.db.createConversation(agentId);
    const firstSession = await container.db.createTurn({
      agentId,
      conversationId: firstConversation.id,
      mode: 'interactive',
      taskDescription: 'hello',
    });
    await container.db.createTurn({
      agentId,
      conversationId: firstConversation.id,
      mode: 'interactive',
      taskDescription: 'follow-up turn without extra messages',
    });
    await container.db.addMessage({
      conversationId: firstConversation.id,
      agentId,
      role: 'user',
      content: 'hello',
    });
    await container.db.addMessage({
      conversationId: firstConversation.id,
      agentId,
      role: 'assistant',
      content: 'hi',
    });

    const secondConversation = await container.db.createConversation(agentId);
    const secondSession = await container.db.createTurn({
      agentId,
      conversationId: secondConversation.id,
      mode: 'background',
      taskDescription: 'second',
    });
    await container.db.addMessage({
      conversationId: secondConversation.id,
      agentId,
      role: 'user',
      content: 'second',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/turns`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      turns: Array<{
        id: string;
        conversationId: string;
        mode: string;
        taskDescription: string | null;
        conversationMessageCount: number;
      }>;
    };
    expect(body).not.toHaveProperty('sessions');
    const turns = body.turns;
    expect(turns).toHaveLength(3);
    expect(turns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstSession.id,
        conversationId: firstConversation.id,
        mode: 'interactive',
        taskDescription: 'hello',
        conversationMessageCount: 2,
      }),
      expect.objectContaining({
        id: secondSession.id,
        conversationId: secondConversation.id,
        mode: 'background',
        taskDescription: 'second',
        conversationMessageCount: 1,
      }),
    ]));
    expect(turns.filter((turn) => turn.conversationId === firstConversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ conversationMessageCount: 2 }),
      ]));
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/nonexistent/turns',
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects interactive turns for a background-only agent before writing a turn', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'background-only-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Run background work only.',
        tools: [],
        mode: 'background',
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${created.json().id}/message`,
      payload: { content: 'This must not start.' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'agent_mode_not_allowed',
      configuredMode: 'background',
      requestedMode: 'interactive',
    });
    expect(await container.db.getTurnsByAgent(created.json().id as string)).toHaveLength(0);
  });

  it('rejects background turns for an interactive-only agent before writing a turn', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'interactive-only-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Run interactive work only.',
        tools: [],
        mode: 'interactive',
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${created.json().id}/turns`,
      payload: { task: 'This must not start.' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'agent_mode_not_allowed',
      configuredMode: 'interactive',
      requestedMode: 'background',
    });
    expect(await container.db.getTurnsByAgent(created.json().id as string)).toHaveLength(0);
  });

  it('replays the original background turn for a repeated idempotency key', async () => {
    const headers = { 'idempotency-key': 'pilot-dispatch-attempt-1' };
    const payload = { task: 'Prepare the same durable close task once' };

    const first = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/turns`,
      headers,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/turns`,
      headers,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    const turns = await container.db.getTurnsByAgent(agentId);
    const matching = turns.filter(
      (turn) => turn.taskDescription === payload.task,
    );
    expect(matching).toHaveLength(1);
  });

  it('coalesces concurrent duplicate background turn requests', async () => {
    const headers = { 'idempotency-key': 'pilot-dispatch-attempt-concurrent' };
    const payload = { task: 'Prepare one turn when duplicate requests race' };

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/turns`,
        headers,
        payload,
      })),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([201, 201, 201, 201]);
    expect(new Set(responses.map((response) => JSON.stringify(response.json()))).size).toBe(1);

    const turns = await container.db.getTurnsByAgent(agentId);
    expect(turns.filter((turn) => turn.taskDescription === payload.task)).toHaveLength(1);
  });

  it('replays a committed result when the original caller has not received its response', async () => {
    const headers = { 'idempotency-key': 'pilot-dispatch-attempt-timeout-after-commit' };
    const payload = { task: 'Recover the exact turn after a response-path timeout' };
    const committed = Promise.withResolvers<void>();
    const releaseOriginalResponse = Promise.withResolvers<void>();
    const originalComplete = container.db.completeTurnStartRequest.bind(container.db);

    container.db.completeTurnStartRequest = async (...args) => {
      const result = await originalComplete(...args);
      committed.resolve();
      await releaseOriginalResponse.promise;
      return result;
    };

    try {
      const originalResponse = app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/turns`,
        headers,
        payload,
      });

      await committed.promise;

      const retryResponse = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/turns`,
        headers,
        payload,
      });

      expect(retryResponse.statusCode).toBe(201);
      expect(retryResponse.json()).toMatchObject({
        turnId: expect.any(String),
        conversationId: expect.any(String),
        sandboxSessionId: null,
      });

      releaseOriginalResponse.resolve();
      const firstResponse = await originalResponse;
      expect(firstResponse.statusCode).toBe(201);
      expect(retryResponse.json()).toEqual(firstResponse.json());

      const turns = await container.db.getTurnsByAgent(agentId);
      expect(turns.filter((turn) => turn.taskDescription === payload.task)).toHaveLength(1);
    } finally {
      releaseOriginalResponse.resolve();
      container.db.completeTurnStartRequest = originalComplete;
    }
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    const headers = { 'idempotency-key': 'pilot-dispatch-attempt-conflict' };
    const first = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/turns`,
      headers,
      payload: { task: 'first close task' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/turns`,
      headers,
      payload: { task: 'different close task' },
    });

    expect(first.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: 'idempotency_conflict',
      idempotencyKey: headers['idempotency-key'],
    });
  });

  it('uses an explicit requestedTurnId as the idempotency identity for interactive messages', async () => {
    const turnId = `pilot-interactive-turn-${randomUUID()}`;
    const payload = {
      content: 'Review the reconciled account',
      requestedTurnId: turnId,
    };
    const first = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/message`,
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/message`,
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ turnId });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
  });
});
