import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentRoutes } from '../routes/agents.js';
import { TypedEventBus } from '../../events/bus.js';
import { registerCallbackSubscriptions } from '../../config/container.js';
import type { DatabaseRepository, WebhookRow } from '../../database/repository.js';
import type { CallbackDispatcher } from '../callback-dispatcher.js';
import { SSEManager } from '../sse.js';
import { InterruptManager } from '../interrupt.js';
import type { AgentSessionService } from '../agent-session-service.js';
import type { SandboxSessionManager } from '../sandbox-session-manager.js';

function createMockDb() {
  const agent = {
    id: 'agent-1',
    name: 'Agent One',
    systemPrompt: 'test',
    tools: [],
    description: null,
    metadata: null,
    workspaceDir: null,
    harness: 'langgraph',
    harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-test' }),
    manifest: null,
    version: 1,
    status: 'created',
    createdAt: 1,
    updatedAt: 1,
  };

  const db = {
    getAgent: vi.fn(async (id: string) => (id === agent.id ? agent : undefined)),
    createWebhook: vi.fn(async (data: {
      id: string;
      agentId: string;
      url: string;
      events: string[];
      secret?: string | null;
      createdAt: number;
      updatedAt: number;
    }) => ({
      ...data,
      secret: data.secret ?? null,
      active: true,
    } satisfies WebhookRow)),
    listWebhooks: vi.fn(async () => [
      {
        id: 'hook-1',
        agentId: 'agent-1',
        url: 'https://hooks.example/run-completed',
        events: ['turn.completed'],
        secret: null,
        active: true,
        createdAt: 10,
        updatedAt: 10,
      },
    ] satisfies WebhookRow[]),
    deleteWebhook: vi.fn(async (id: string) => id === 'hook-1'),
    deleteWebhookForAgent: vi.fn(async (id: string, agentId?: string) => id === 'hook-1' && (!agentId || agentId === 'agent-1')),
    updateWebhookForAgent: vi.fn(async (
      id: string,
      agentId: string,
      data: { url: string; events: string[]; secret?: string | null },
    ) => (id === 'hook-1' && agentId === 'agent-1'
      ? {
          id,
          agentId,
          url: data.url,
          events: data.events,
          secret: data.secret ?? null,
          active: true,
          createdAt: 10,
          updatedAt: 20,
        } satisfies WebhookRow
      : undefined)),
    getWebhooksForAgent: vi.fn(async () => [] as WebhookRow[]),
  };

  return db as unknown as DatabaseRepository & typeof db;
}

async function buildApp(db: DatabaseRepository): Promise<FastifyInstance> {
  const app = Fastify();
  const configSchema = z.object({ model: z.string().min(1) }).passthrough();
  const harness = {
    name: 'langgraph',
    configSchema,
    openSession: vi.fn(),
  };
  const sessionManager = {
    ensureSession: vi.fn(),
    deliverTurn: vi.fn(),
    killSession: vi.fn(),
    findSessionById: vi.fn(),
    startTurn: vi.fn(),
    completeTurn: vi.fn(),
    cancelCurrentTurn: vi.fn(),
    getAbortSignal: vi.fn(),
    getTurn: vi.fn(),
    getActiveTurns: vi.fn(() => []),
  } as unknown as SandboxSessionManager;
  await app.register(agentRoutes, {
    prefix: '/api/agents',
    db,
    sse: new SSEManager(),
    interrupts: new InterruptManager(),
    sessionManager,
    harnessRegistry: {
      register: vi.fn(),
      get: vi.fn(() => harness),
      getConfigSchema: vi.fn(() => configSchema),
      list: vi.fn(() => ['langgraph']),
    },
    agentSessionService: {
      executeSession: vi.fn(),
    } as unknown as AgentSessionService,
    eventBus: new TypedEventBus(),
  });
  await app.ready();
  return app;
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('webhook routes', () => {
  let app: FastifyInstance;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    db = createMockDb();
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a webhook with valid events', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/webhooks',
      payload: {
        url: 'https://hooks.example/new',
        events: ['turn.started', 'turn.completed'],
        secret: 'top-secret',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(db.createWebhook).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.any(String),
      agentId: 'agent-1',
      url: 'https://hooks.example/new',
      events: ['turn.started', 'turn.completed'],
      secret: 'top-secret',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    }));

    expect(response.json()).toEqual(expect.objectContaining({
      agentId: 'agent-1',
      url: 'https://hooks.example/new',
      events: ['turn.started', 'turn.completed'],
      secret: 'top-secret',
      active: true,
    }));
  });

  it('rejects invalid event types', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/agent-1/webhooks',
      payload: {
        url: 'https://hooks.example/new',
        events: ['turn.completed', 'run.unknown'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid event types: run.unknown',
      validEvents: ['turn.started', 'turn.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved', 'message.committed'],
    });
    expect(db.createWebhook).not.toHaveBeenCalled();
  });

  it('updates a webhook with valid events', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/agents/agent-1/webhooks/hook-1',
      payload: {
        url: 'https://hooks.example/updated',
        events: ['turn.completed', 'message.committed'],
        secret: 'rotated-secret',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(db.updateWebhookForAgent).toHaveBeenCalledWith('hook-1', 'agent-1', {
      url: 'https://hooks.example/updated',
      events: ['turn.completed', 'message.committed'],
      secret: 'rotated-secret',
    });
    expect(response.json()).toEqual(expect.objectContaining({
      id: 'hook-1',
      agentId: 'agent-1',
      url: 'https://hooks.example/updated',
      events: ['turn.completed', 'message.committed'],
      secret: 'rotated-secret',
    }));
  });

  it('rejects invalid event types when updating a webhook', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/agents/agent-1/webhooks/hook-1',
      payload: {
        url: 'https://hooks.example/updated',
        events: ['message.committed', 'run.unknown'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(db.updateWebhookForAgent).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: 'Invalid event types: run.unknown',
      validEvents: ['turn.started', 'turn.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved', 'message.committed'],
    });
  });

  it('returns 404 when updating a webhook outside the agent', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/agents/agent-1/webhooks/other-hook',
      payload: {
        url: 'https://hooks.example/updated',
        events: ['turn.completed'],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Webhook not found' });
  });

  it('lists webhooks for an agent', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/agents/agent-1/webhooks',
    });

    expect(response.statusCode).toBe(200);
    expect(db.listWebhooks).toHaveBeenCalledWith('agent-1');
    expect(response.json()).toEqual([
      expect.objectContaining({
        id: 'hook-1',
        agentId: 'agent-1',
        url: 'https://hooks.example/run-completed',
      }),
    ]);
  });

  it('deletes a webhook', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/agents/agent-1/webhooks/hook-1',
    });

    expect(response.statusCode).toBe(204);
    expect(db.deleteWebhookForAgent).toHaveBeenCalledWith('hook-1', 'agent-1');
  });
});

describe('callback subscriptions', () => {
  function createSubscriptionDb(overrides?: { webhooks?: WebhookRow[] }) {
    const db = {
      getWebhooksForAgent: vi.fn(async () => overrides?.webhooks ?? []),
    };

    return db as unknown as DatabaseRepository & typeof db;
  }

  function createDispatcher() {
    const dispatcher = {
      enqueue: vi.fn(async () => 'delivery-id'),
    };
    return dispatcher as unknown as CallbackDispatcher & typeof dispatcher;
  }

  it('enqueues every valid webhook event to subscribed webhooks', async () => {
    const eventBus = new TypedEventBus();
    const events = ['turn.started', 'turn.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved', 'message.committed'];
    const db = createSubscriptionDb({ webhooks: events.map((event, index) => ({
      id: `hook-${index}`,
      agentId: 'agent-1',
      url: `https://hooks.example/${event}`,
      events: [event],
      secret: null,
      active: true,
      createdAt: 1,
      updatedAt: 1,
    })) as WebhookRow[] });
    const callbackDispatcher = createDispatcher();

    registerCallbackSubscriptions(eventBus, db, callbackDispatcher);
    eventBus.emit('turn.started', {
      turnId: 'run-1',
      sessionId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      mode: 'interactive',
      taskDescription: 'Start task',
      timestamp: 123,
    });
    eventBus.emit('turn.completed', {
      turnId: 'run-1',
      sessionId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'completed',
      durationMs: 400,
      timestamp: 456,
    });
    eventBus.emit('run.tool_started', {
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'ctxmill' },
      timestamp: 789,
    });
    eventBus.emit('run.tool_result', {
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      result: '{"ok":true}',
      durationMs: 12,
      timestamp: 790,
    });
    eventBus.emit('run.interrupted', {
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-2',
      toolName: 'approve',
      args: { amount: 5 },
      interruptId: 'int-1',
      timestamp: 791,
    });
    eventBus.emit('run.interrupt_resolved', {
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      interruptId: 'int-1',
      action: 'approve',
      timestamp: 792,
    });
    eventBus.emit('message.committed', {
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      messageSeq: 2,
      role: 'assistant',
      content: 'done',
      timestamp: 793,
    });
    await flushEvents();

    expect(callbackDispatcher.enqueue).toHaveBeenCalledTimes(events.length);
    expect(callbackDispatcher.enqueue.mock.calls.map(([delivery]) => delivery.eventType)).toEqual(events);
    expect(callbackDispatcher.enqueue).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-1',
      sessionId: 'run-1',
      callbackUrl: 'https://hooks.example/turn.started',
      eventType: 'turn.started',
      payload: {
        turnId: 'run-1',
        sessionId: 'run-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        mode: 'interactive',
        taskDescription: 'Start task',
        timestamp: 123,
      },
    });
  });

  it('enqueues run.completed to subscribed webhooks', async () => {
    const eventBus = new TypedEventBus();
    const db = createSubscriptionDb({
      webhooks: [
        {
          id: 'hook-1',
          agentId: 'agent-1',
          url: 'https://hooks.example/run-completed',
          events: ['turn.completed'],
          secret: null,
          active: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const callbackDispatcher = createDispatcher();

    registerCallbackSubscriptions(eventBus, db, callbackDispatcher);
    eventBus.emit('turn.completed', {
      turnId: 'run-1',
      sessionId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      status: 'completed',
      durationMs: 400,
      timestamp: 456,
    });
    await flushEvents();

    expect(callbackDispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(callbackDispatcher.enqueue).toHaveBeenNthCalledWith(1, {
      agentId: 'agent-1',
      sessionId: 'run-1',
      callbackUrl: 'https://hooks.example/run-completed',
      eventType: 'turn.completed',
      payload: {
        turnId: 'run-1',
        sessionId: 'run-1',
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'completed',
        error: undefined,
        durationMs: 400,
        timestamp: 456,
      },
    });
  });

  it('filters webhook deliveries by subscribed event type', async () => {
    const eventBus = new TypedEventBus();
    const db = createSubscriptionDb({
      webhooks: [
        {
          id: 'hook-1',
          agentId: 'agent-1',
          url: 'https://hooks.example/run-completed',
          events: ['turn.completed'],
          secret: null,
          active: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'hook-2',
          agentId: 'agent-1',
          url: 'https://hooks.example/run-tool-started',
          events: ['run.tool_started'],
          secret: null,
          active: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const callbackDispatcher = createDispatcher();

    registerCallbackSubscriptions(eventBus, db, callbackDispatcher);
    eventBus.emit('run.tool_started', {
      turnId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { query: 'ctxmill' },
      timestamp: 789,
    });
    await flushEvents();

    expect(callbackDispatcher.enqueue).toHaveBeenCalledTimes(1);
     expect(callbackDispatcher.enqueue).toHaveBeenNthCalledWith(1, {
       agentId: 'agent-1',
       sessionId: 'run-1',
       callbackUrl: 'https://hooks.example/run-tool-started',
       eventType: 'run.tool_started',
       payload: {
         turnId: 'run-1',
         agentId: 'agent-1',
         conversationId: 'conv-1',
         toolCallId: 'tool-1',
         toolName: 'search',
         args: { query: 'ctxmill' },
         requiresApproval: undefined,
         timestamp: 789,
       },
     });
  });
});
