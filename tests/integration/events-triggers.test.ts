import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

describe('Events and Triggers Integration', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;

  // Shared state across tests
  let agentId: string;
  let triggerId: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'ctxmill-ekt-',
    });
    app = testApp.app;
    container = testApp.container;
  });

  afterAll(async () => {
    await testApp?.close();
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
  // Feedback signal endpoint and removed trace/stat endpoints
  // ────────────────────────────────────────────────────────

  describe('Feedback and removed learning endpoints', () => {
    it('POST /api/agents/:id/feedback emits feedback.received', async () => {
      const received = new Promise<unknown>((resolve) => {
        container.eventBus.once('feedback.received', resolve);
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId: 'conversation-feedback-test',
          messageId: 'message-feedback-test',
          type: 'thumbs_up',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.feedbackId).toEqual(expect.any(String));
      expect(body.turnId).toBe('conversation-feedback-test');
      await expect(received).resolves.toMatchObject({
        feedbackId: body.feedbackId,
        turnId: 'conversation-feedback-test',
        agentId,
        type: 'thumbs_up',
        messageId: 'message-feedback-test',
      });
    });

    it('trace and feedback stats endpoints are removed', async () => {
      for (const url of [
        `/api/agents/${agentId}/traces`,
        `/api/agents/${agentId}/traces?limit=5`,
        `/api/agents/${agentId}/traces/stats`,
        `/api/agents/${agentId}/feedback/stats`,
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(404);
      }
    });
  });
});
