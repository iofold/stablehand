import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { verifyCtxmillWebhook } from '@ctxmill/contracts';
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

      it('persists and relays an HTTP custom event through the live spine', async () => {
        const eventAgentId = agentId || await createAgent('Custom Relay Agent');
        const eventType = `custom.eval.verdict.${Date.now()}`;
        const callerPayload = {
          turnId: '',
          conversationId: '   ',
          verdict: 'pass',
          evidence: { suite: 'integration', scores: [1, 2, 3] },
        };
        const signingSecret = 'integration-signing-secret';
        const fetchDelivery = vi.fn(async (
          _url: string,
          _init: RequestInit,
        ) => new Response(null, { status: 204 }));
        const previousFetch = container.callbackDispatcher.fetchFn;
        container.callbackDispatcher.fetchFn = fetchDelivery;

        try {
          const subscribed = await app.inject({
            method: 'POST',
            url: `/api/agents/${eventAgentId}/webhooks`,
            payload: {
              url: 'https://pack-b.test/hooks/ctxmill',
              events: [eventType],
              secret: signingSecret,
            },
          });
          expect(subscribed.statusCode).toBe(201);

          const emitted = await app.inject({
            method: 'POST',
            url: '/api/triggers/emit',
            payload: {
              type: eventType,
              agentId: eventAgentId,
              payload: callerPayload,
            },
          });
          expect(emitted.statusCode).toBe(200);

          for (let attempt = 0; attempt < 20 && fetchDelivery.mock.calls.length === 0; attempt++) {
            await container.callbackDispatcher.processPending();
            if (fetchDelivery.mock.calls.length === 0) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }

          expect(fetchDelivery).toHaveBeenCalledOnce();
          const [deliveryUrl, deliveryInit] = fetchDelivery.mock.calls[0];
          expect(deliveryUrl).toBe('https://pack-b.test/hooks/ctxmill');
          const headers = new Headers(deliveryInit?.headers);
          const rawBody = String(deliveryInit?.body);
          expect(headers.get('X-Event-Type')).toBe(eventType);
          const verified = await verifyCtxmillWebhook({
            headers,
            rawBody,
            secrets: signingSecret,
            nowSeconds: Number(headers.get('X-Webhook-Timestamp')),
          });
          expect(verified).toMatchObject({
            valid: true,
            payload: {
              type: eventType,
              agentId: eventAgentId,
              payload: callerPayload,
            },
          });
          if (!verified.valid) {
            throw new Error(`Expected valid signed webhook, got ${verified.reason}`);
          }
          expect(verified.payload).not.toHaveProperty('turnId');
          expect(verified.payload).not.toHaveProperty('conversationId');

          const persisted = await app.inject({
            method: 'GET',
            url: `/api/events?type=${encodeURIComponent(eventType)}`,
          });
          expect(persisted.statusCode).toBe(200);
          expect(persisted.json().events).toEqual([
            expect.objectContaining({
              type: eventType,
              agentId: eventAgentId,
            }),
          ]);
        } finally {
          container.callbackDispatcher.fetchFn = previousFetch;
        }
      });

      it('POST /api/triggers/emit rejects event names outside custom.*', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers/emit',
          payload: {
            type: 'analysis.complete',
            payload: { message: 'legacy external name' },
          },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid_custom_event' });
      });

      it('POST /api/triggers/emit rejects payloads above 32 KiB with a typed 413', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers/emit',
          payload: {
            type: 'custom.eval.large',
            payload: { content: 'x'.repeat(32 * 1024) },
          },
        });
        expect(res.statusCode).toBe(413);
        expect(res.json()).toEqual({
          error: 'custom_event_payload_too_large',
          maxBytes: 32 * 1024,
        });
      });

      it('persists HTTP custom-event correlation fields for composable event filters', async () => {
        const eventAgentId = agentId || await createAgent('Correlation Filter Agent');
        const marker = `correlation-${Date.now()}`;
        const turnId = `turn-${marker}`;
        const conversationId = `conversation-${marker}`;
        const otherTurnId = `turn-other-${marker}`;

        for (const [currentTurnId, value] of [[turnId, 'target'], [otherTurnId, 'other']] as const) {
          const emitted = await app.inject({
            method: 'POST',
            url: '/api/triggers/emit',
            payload: {
              type: 'custom.correlation.probe',
              agentId: eventAgentId,
              payload: {
                turnId: currentTurnId,
                conversationId,
                marker,
                value,
              },
            },
          });
          expect(emitted.statusCode).toBe(200);
        }

        const byTurn = await app.inject({
          method: 'GET',
          url: `/api/events?turnId=${encodeURIComponent(turnId)}`,
        });
        expect(byTurn.statusCode).toBe(200);
        expect(byTurn.json().events).toEqual([
          expect.objectContaining({
            type: 'custom.correlation.probe',
            turnId,
            conversationId,
          }),
        ]);

        const byConversation = await app.inject({
          method: 'GET',
          url: `/api/events?conversationId=${encodeURIComponent(conversationId)}`,
        });
        expect(byConversation.statusCode).toBe(200);
        expect(byConversation.json().events).toHaveLength(2);

        const composed = await app.inject({
          method: 'GET',
          url: `/api/events?turnId=${encodeURIComponent(turnId)}&conversationId=${encodeURIComponent(conversationId)}`,
        });
        expect(composed.statusCode).toBe(200);
        expect(composed.json().events).toEqual([
          expect.objectContaining({ turnId, conversationId }),
        ]);
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

      it('POST /api/triggers/emit rejects array payloads', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/triggers/emit',
          payload: { type: 'custom.test', payload: ['not', 'an', 'object'] },
        });
        expect(res.statusCode).toBe(400);
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Feedback signal endpoint and removed trace/stat endpoints
  // ────────────────────────────────────────────────────────

  describe('Feedback and removed learning endpoints', () => {
    it('attributes feedback to the exact turn that owns the target message', async () => {
      const conversation = await container.db.createConversation(agentId);
      const targetTurn = await container.db.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        taskDescription: 'feedback target',
        startedAt: 1_000,
      });
      const targetMessage = await container.db.addMessage({
        id: 'message-feedback-target',
        conversationId: conversation.id,
        agentId,
        turnId: targetTurn.id,
        role: 'assistant',
        content: 'older answer',
      });
      const newerTurn = await container.db.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        taskDescription: 'newer turn',
        startedAt: 2_000,
      });
      await container.db.addMessage({
        id: 'message-feedback-newer',
        conversationId: conversation.id,
        agentId,
        turnId: newerTurn.id,
        role: 'assistant',
        content: 'newer answer',
      });
      const received = new Promise<unknown>((resolve) => {
        container.eventBus.once('feedback.received', resolve);
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId: conversation.id,
          messageId: targetMessage.id,
          type: 'thumbs_up',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.feedbackId).toEqual(expect.any(String));
      expect(body.turnId).toBe(targetTurn.id);
      await expect(received).resolves.toMatchObject({
        feedbackId: body.feedbackId,
        turnId: targetTurn.id,
        agentId,
        type: 'thumbs_up',
        messageId: targetMessage.id,
      });
    });

    it('requires a messageId instead of falling back to the conversation latest turn', async () => {
      const conversation = await container.db.createConversation(agentId);
      await container.db.createTurn({
        agentId,
        conversationId: conversation.id,
        mode: 'interactive',
        taskDescription: 'feedback target',
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId: conversation.id,
          type: 'thumbs_down',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'conversationId, messageId, and type ("thumbs_up" or "thumbs_down") are required' });
    });

    it('rejects a message that is not owned by the agent and conversation', async () => {
      const conversation = await container.db.createConversation(agentId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/feedback`,
        payload: {
          conversationId: conversation.id,
          messageId: 'unknown-message',
          type: 'thumbs_down',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Feedback message not found' });
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
