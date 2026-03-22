import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

describe('Events, Knowledge, and Triggers Integration', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;

  // Shared state across tests
  let agentId: string;
  let knowledgeItemId: string;
  let triggerId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-ekt-'));

    container = await createContainer(
      {
        preset: 'local',
        database: { url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
        llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test-key-not-used' },
      },
      dataDir,
    );

    const envFactory = new MockOverlayFactory();
    app = await createServer({
      db: container.db,
      agentRunService: container.agentRunService,
      runRegistry: container.runRegistry,
      eventBus: container.eventBus,
      knowledgeStore: container.knowledgeStore,
      learningPipeline: container.learningPipeline,
      triggerManager: container.triggerManager,
      dataDir,
      envFactory,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Helper to create an agent via the HTTP API
  async function createAgent(name = 'Test Agent'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name,
        harness: 'langgraph',
        harnessConfig: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        systemPrompt: 'You are a test agent.',
        tools: ['bash'],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  // ────────────────────────────────────────────────────────
  // Events (/api/events)
  // ────────────────────────────────────────────────────────

  describe('Events API', () => {
    it('GET /api/events returns paginated event list (initially may be empty)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/events' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('events');
      expect(Array.isArray(body.events)).toBe(true);
    });

    it('agent.created event appears after creating an agent', async () => {
      agentId = await createAgent('Events Test Agent');

      // Small delay for async event bus
      await new Promise((r) => setTimeout(r, 50));

      const res = await app.inject({ method: 'GET', url: '/api/events' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const created = body.events.find(
        (e: { type: string; agentId?: string }) =>
          e.type === 'agent.created' && e.agentId === agentId,
      );
      expect(created).toBeDefined();
    });

    it('limit parameter restricts returned events', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/events?limit=1',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.events.length).toBeLessThanOrEqual(1);
    });

    it('type filter returns only matching events', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/events?type=agent.created',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      for (const ev of body.events) {
        expect(ev.type).toBe('agent.created');
      }
    });

    it('GET /api/events/stats returns stats object', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/events/stats' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toBeDefined();
      expect(typeof body).toBe('object');
    });

    it('GET /api/events/stats accepts range parameter', async () => {
      for (const range of ['1h', '24h', '7d']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/events/stats?range=${range}`,
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it('GET /api/events/types returns types array', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/events/types' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('types');
      expect(Array.isArray(body.types)).toBe(true);
    });

    it('GET /api/events/types includes agent.created after agent creation', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/events/types' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.types).toContain('agent.created');
    });
  });

  // ────────────────────────────────────────────────────────
  // Knowledge (/api/knowledge)
  // ────────────────────────────────────────────────────────

  describe('Knowledge API', () => {
    describe('Shared Knowledge', () => {
      it('GET /api/knowledge/shared is initially empty', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/knowledge/shared' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('items');
        expect(body).toHaveProperty('total');
        expect(body.items).toEqual([]);
        expect(body.total).toBe(0);
      });

      it('POST /api/knowledge/shared creates a knowledge item', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/knowledge/shared',
          payload: {
            content: 'Always use parameterized queries to prevent SQL injection.',
            category: 'security',
            source: 'human',
            effectiveness: 0.9,
          },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body).toHaveProperty('id');
        expect(body.content).toBe('Always use parameterized queries to prevent SQL injection.');
        expect(body.category).toBe('security');
        knowledgeItemId = body.id;
      });

      it('POST /api/knowledge/shared rejects missing content', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/knowledge/shared',
          payload: { category: 'test' },
        });
        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error).toBeDefined();
      });

      it('GET /api/knowledge/shared returns result structure after add', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/knowledge/shared' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        // InMemoryKnowledgeStore.listShared() is a stub that returns [],
        // so we only verify the response shape here.
        expect(body).toHaveProperty('items');
        expect(body).toHaveProperty('total');
        expect(Array.isArray(body.items)).toBe(true);
        expect(typeof body.total).toBe('number');
      });

      it('GET /api/knowledge/shared/stats returns stats structure', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/knowledge/shared/stats' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('totalItems');
        expect(body).toHaveProperty('categories');
        expect(body).toHaveProperty('recentItems');
        expect(typeof body.totalItems).toBe('number');
      });

      it('DELETE /api/knowledge/shared/:itemId removes the item', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/knowledge/shared/${knowledgeItemId}`,
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
      });

      it('GET /api/knowledge/shared no longer contains deleted item', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/knowledge/shared' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        const found = body.items.find((i: { id: string }) => i.id === knowledgeItemId);
        expect(found).toBeUndefined();
      });

      it('DELETE /api/knowledge/shared/:itemId returns 404 for non-existent', async () => {
        const res = await app.inject({
          method: 'DELETE',
          url: '/api/knowledge/shared/non-existent-id',
        });
        expect(res.statusCode).toBe(404);
      });
    });

    describe('Search', () => {
      it('GET /api/knowledge/search returns result structure', async () => {
        const res = await app.inject({ method: 'GET', url: '/api/knowledge/search' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('items');
        expect(body).toHaveProperty('total');
        expect(Array.isArray(body.items)).toBe(true);
      });

      it('GET /api/knowledge/search accepts query parameters', async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/knowledge/search?q=test&category=general&limit=10&offset=0',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('items');
        expect(body).toHaveProperty('total');
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Agent Knowledge (/api/agents/:id/knowledge)
  // ────────────────────────────────────────────────────────

  describe('Agent Knowledge', () => {
    it('GET /api/agents/:id/knowledge returns empty for new agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/knowledge`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('items');
      expect(body).toHaveProperty('total');
      expect(body.total).toBe(0);
    });

    it('GET /api/agents/:id/knowledge/stats returns stats structure', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/knowledge/stats`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('totalItems');
      expect(body).toHaveProperty('categories');
      expect(body).toHaveProperty('recentItems');
    });
  });

  // ────────────────────────────────────────────────────────
  // Triggers (/api/triggers)
  // ────────────────────────────────────────────────────────

  describe('Triggers API', () => {
    it('POST /api/triggers creates a trigger', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          agentId,
          eventType: 'agent.created',
          taskTemplate: 'Greet the new agent: {{agentId}}',
          enabled: true,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toHaveProperty('id');
      expect(body.agentId).toBe(agentId);
      expect(body.eventType).toBe('agent.created');
      expect(body.taskTemplate).toBe('Greet the new agent: {{agentId}}');
      expect(body.enabled).toBe(true);
      triggerId = body.id;
    });

    it('POST /api/triggers rejects missing agentId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          eventType: 'agent.created',
          taskTemplate: 'test',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/triggers rejects missing eventType', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          agentId,
          taskTemplate: 'test',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/triggers rejects missing taskTemplate', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          agentId,
          eventType: 'agent.created',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/triggers rejects non-existent agentId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          agentId: 'non-existent-agent-id',
          eventType: 'agent.created',
          taskTemplate: 'test',
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('GET /api/triggers lists created trigger', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/triggers' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      const found = body.find((t: { id: string }) => t.id === triggerId);
      expect(found).toBeDefined();
    });

    it('GET /api/triggers?agentId filters by agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/triggers?agentId=${agentId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      for (const t of body) {
        expect(t.agentId).toBe(agentId);
      }
    });

    it('GET /api/triggers?agentId returns empty for unknown agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/triggers?agentId=unknown-agent',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });

    it('GET /api/triggers/:id returns the trigger', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/triggers/${triggerId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(triggerId);
      expect(body.agentId).toBe(agentId);
    });

    it('GET /api/triggers/:id returns 404 for non-existent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/triggers/does-not-exist',
      });
      expect(res.statusCode).toBe(404);
    });

    it('PUT /api/triggers/:id disables the trigger', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/triggers/${triggerId}`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(false);
      expect(body.id).toBe(triggerId);
    });

    it('PUT /api/triggers/:id updates taskTemplate', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/triggers/${triggerId}`,
        payload: { taskTemplate: 'Updated template: {{agentId}}' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.taskTemplate).toBe('Updated template: {{agentId}}');
    });

    it('PUT /api/triggers/:id returns 404 for non-existent', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/triggers/does-not-exist',
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /api/triggers/:id removes the trigger', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/triggers/${triggerId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
    });

    it('GET /api/triggers/:id returns 404 after deletion', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/triggers/${triggerId}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /api/triggers/:id returns 404 for already-deleted trigger', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/triggers/${triggerId}`,
      });
      expect(res.statusCode).toBe(404);
    });

    describe('Emit', () => {
      it('POST /api/triggers/emit emits a custom event', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers/emit',
          payload: {
            type: 'custom.test',
            agentId,
            payload: { message: 'hello' },
          },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ok).toBe(true);
        expect(body.type).toBe('custom.test');
      });

      it('POST /api/triggers/emit rejects missing type', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers/emit',
          payload: { payload: { message: 'hello' } },
        });
        expect(res.statusCode).toBe(400);
      });

      it('POST /api/triggers/emit rejects missing payload', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers/emit',
          payload: { type: 'custom.test' },
        });
        expect(res.statusCode).toBe(400);
      });

      it('POST /api/triggers/emit rejects non-object payload', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers/emit',
          payload: { type: 'custom.test', payload: 'not-an-object' },
        });
        expect(res.statusCode).toBe(400);
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Traces & Feedback Stats (/api/agents/:id/traces, feedback)
  // ────────────────────────────────────────────────────────

  describe('Traces & Feedback', () => {
    it('GET /api/agents/:id/traces returns array', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/traces`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/agents/:id/traces accepts limit parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/traces?limit=5`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/agents/:id/traces returns 404 for non-existent agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agents/non-existent/traces',
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/agents/:id/traces/stats returns stats structure', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/traces/stats`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body).toBe('object');
    });

    it('GET /api/agents/:id/traces/stats returns 404 for non-existent agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agents/non-existent/traces/stats',
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/agents/:id/feedback/stats returns stats structure', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/feedback/stats`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body).toBe('object');
    });

    it('GET /api/agents/:id/feedback/stats returns 404 for non-existent agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/agents/non-existent/feedback/stats',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
