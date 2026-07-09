import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentRoutes } from '../routes/agents.js';
import { TypedEventBus } from '../../events/bus.js';
import type { DatabaseRepository, WebhookRow } from '../../database/repository.js';
import { SSEManager } from '../sse.js';
import { InterruptManager } from '../interrupt.js';
import type { AgentSessionService } from '../agent-session-service.js';
import type { RunStartupService } from '../run-startup-service.js';
import type { SandboxSessionManager } from '../sandbox-session-manager.js';
import { createTestRunStartupService } from './run-startup-test-helper.js';

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
  };

  return db as unknown as DatabaseRepository & typeof db;
}

function createRunStartupServiceStub(): RunStartupService {
  return createTestRunStartupService();
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
    runStartupService: createRunStartupServiceStub(),
    eventBus: new TypedEventBus(),
  });
  await app.ready();
  return app;
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
      validEvents: ['turn.started', 'turn.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved', 'message.committed', 'feedback.received'],
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
      validEvents: ['turn.started', 'turn.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved', 'message.committed', 'feedback.received'],
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
