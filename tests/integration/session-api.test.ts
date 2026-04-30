import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';

describe('Session API lifecycle', () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let container: AppContainer;
  let dataDir: string;
  let agentId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-session-test-'));

    container = await createContainer(
      {
        preset: 'docker',
        database: {
          url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill',
        },
      },
      dataDir,
    );

    app = await createServer({
      db: container.db,
      agentSessionService: container.agentSessionService,
      eventBus: container.eventBus,
      sessionManager: container.sessionManager,
      runStartupService: container.runStartupService,
      dataDir,
    });

    await app.ready();

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
    await app.close();
    await container.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /api/agents/:id/sessions returns persisted sessions', async () => {
    const firstConversation = await container.db.createConversation(agentId);
    const firstSession = await container.db.createTurn({
      agentId,
      conversationId: firstConversation.id,
      mode: 'interactive',
      taskDescription: 'hello',
    });

    const secondConversation = await container.db.createConversation(agentId);
    const secondSession = await container.db.createTurn({
      agentId,
      conversationId: secondConversation.id,
      mode: 'background',
      taskDescription: 'second',
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
      }>;
    };
    const sessions = body.sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: firstSession.id,
        conversationId: firstConversation.id,
        mode: 'interactive',
        taskDescription: 'hello',
      }),
      expect.objectContaining({
        id: secondSession.id,
        conversationId: secondConversation.id,
        mode: 'background',
        taskDescription: 'second',
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
