import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';

describe('Session API lifecycle', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;
  let agentId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-session-test-'));

    container = await createContainer(
      {
        preset: 'local',
        database: {
          url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill',
        },
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          apiKey: 'test-key-not-used',
        },
      },
      dataDir,
    );

    app = await createServer({
      db: container.db,
      agentRunService: container.agentRunService,
      runRegistry: container.runRegistry,
      eventBus: container.eventBus,
      dataDir,
    });

    await app.ready();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'session-test-agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
        systemPrompt: 'You are a test agent.',
        tools: [],
      },
    });
    expect(createRes.statusCode).toBe(201);
    agentId = createRes.json().id;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /api/agents/:id/sessions returns conversation summaries', async () => {
    const firstConversation = await container.db.createConversation(agentId);
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
        conversationId: string;
        startedAt: number;
        messageCount: number | string;
        lastMessageAt: number | string | null;
      }>;
    };
    const sessions = body.sessions.map((session) => ({
      ...session,
      messageCount: Number(session.messageCount),
      lastMessageAt: session.lastMessageAt === null ? null : Number(session.lastMessageAt),
    }));
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: firstConversation.id,
        messageCount: 2,
        lastMessageAt: expect.any(Number),
      }),
      expect.objectContaining({
        conversationId: secondConversation.id,
        messageCount: 1,
        lastMessageAt: expect.any(Number),
      }),
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
