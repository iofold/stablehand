import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

describe('Session API lifecycle', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;
  let agentId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'ctxmill-session-test-',
      preset: 'docker',
    });
    app = testApp.app;
    container = testApp.container;

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
    await testApp?.close();
  });

  it('GET /api/agents/:id/sessions returns persisted sessions', async () => {
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
      url: `/api/agents/${agentId}/sessions`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sessions: Array<{
        id: string;
        conversationId: string;
        mode: string;
        taskDescription: string | null;
        messageCount: number;
      }>;
    };
    const sessions = body.sessions;
    expect(sessions).toHaveLength(3);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstSession.id,
        conversationId: firstConversation.id,
        mode: 'interactive',
        taskDescription: 'hello',
        messageCount: 2,
      }),
      expect.objectContaining({
        id: secondSession.id,
        conversationId: secondConversation.id,
        mode: 'background',
        taskDescription: 'second',
        messageCount: 1,
      }),
    ]));
    expect(sessions.filter((session) => session.conversationId === firstConversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ messageCount: 2 }),
      ]));
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/nonexistent/sessions',
    });

    expect(res.statusCode).toBe(404);
  });
});
