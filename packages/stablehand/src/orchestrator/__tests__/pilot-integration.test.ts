import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallbackOutboxRow, DatabaseRepository, EventFrameRow, WebhookRow } from '../../database/repository.js';
import type { CallbackOutboxInsert } from '../../database/types.js';
import { SpineConsumerRunner } from '../../events/spine-consumer-runner.js';
import { TypedEventBus } from '../../events/bus.js';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import { CallbackDispatcher } from '../callback-dispatcher.js';
import { CanonicalLog } from '../canonical/canonical-log.js';
import type { AgentTurnService } from '../agent-turn-service.js';
import { InterruptManager } from '../interrupt.js';
import { agentRoutes } from '../routes/agents.js';
import { mapAgentHttpToolsToConfigs } from '../http-tools.js';
import { SSEManager } from '../sse.js';
import { TurnStartupService } from '../turn-startup-service.js';
import { TurnSecretEnvelopeCodec } from '../turn-secret-envelope.js';
import type { SandboxSessionManager } from '../sandbox-session-manager.js';
import { createWebhookRelaySpineConsumer } from '../webhook-relay.js';

const TEST_TURN_SECRET_CODEC = new TurnSecretEnvelopeCodec(Buffer.alloc(32, 11));

type AgentRow = {
  id: string;
  name: string;
  systemPrompt: string;
  tools: string[];
  description: string | null;
  metadata: Record<string, unknown> | null;
  workspaceDir: string | null;
  harness: string;
  harnessConfig: string;
  manifest: Record<string, unknown> | null;
  version: number;
  status: string;
  createdAt: number;
  updatedAt: number;
};

type MessageRow = {
  id: string;
  agentId: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string | null;
  createdAt: number;
};

type TurnRow = {
  id: string;
  agentId: string;
  conversationId: string;
  sandboxSessionId?: string | null;
  status: string;
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  taskDescription: string | null;
};

function createAgentRow(overrides?: Partial<AgentRow>): AgentRow {
  return {
    id: 'agent-1',
    name: 'Pilot Agent',
    systemPrompt: 'Be helpful',
    tools: [],
    description: null,
    metadata: null,
    workspaceDir: null,
    harness: 'langgraph',
    harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-test' }),
    manifest: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createMockDb(options?: { agents?: AgentRow[]; webhooks?: WebhookRow[] }) {
  const agents = new Map((options?.agents ?? []).map((agent) => [agent.id, { ...agent }]));
  const webhooks = new Map((options?.webhooks ?? []).map((hook) => [hook.id, { ...hook }]));
  const conversations = new Map<string, { id: string; agentId: string; createdAt: number; updatedAt: number }>();
  const messages = new Map<string, MessageRow[]>();
  const turns = new Map<string, TurnRow>();
  const turnSecretEnvelopes = new Map<string, {
    turnId: string;
    iv: string;
    ciphertext: string;
    authTag: string;
    createdAt: number;
  }>();
  const callbackOutbox = new Map<string, CallbackOutboxRow>();

  let agentCounter = agents.size;
  let conversationCounter = 0;
  let messageCounter = 0;

  const db = {
    createAgent: vi.fn(async (data: Record<string, unknown>) => {
      agentCounter += 1;
      const now = Date.now();
      const id = `agent-${agentCounter}`;
      const agent = createAgentRow({
        id,
        name: String(data.name),
        systemPrompt: String(data.systemPrompt),
        tools: (data.tools as string[]) ?? [],
        description: (data.description as string | null | undefined) ?? null,
        metadata: (data.metadata as Record<string, unknown> | null | undefined) ?? null,
        harness: String(data.harness ?? 'langgraph'),
        harnessConfig: String(data.harnessConfig),
        createdAt: now,
        updatedAt: now,
      });
      agents.set(id, agent);
      return { ...agent };
    }),
    getAgent: vi.fn(async (id: string) => {
      const agent = agents.get(id);
      return agent ? { ...agent } : undefined;
    }),
    updateAgent: vi.fn(async (id: string, data: Partial<AgentRow>) => {
      const existing = agents.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...data, updatedAt: Date.now() };
      agents.set(id, updated);
      return { ...updated };
    }),
    createConversation: vi.fn(async (agentId: string) => {
      conversationCounter += 1;
      const now = Date.now();
      const conversation = { id: `conv-${conversationCounter}`, agentId, createdAt: now, updatedAt: now };
      conversations.set(conversation.id, conversation);
      messages.set(conversation.id, []);
      return { ...conversation };
    }),
    addMessage: vi.fn(async (data: Omit<MessageRow, 'id' | 'createdAt'> & { createdAt?: number }) => {
      messageCounter += 1;
      const row: MessageRow = {
        id: `msg-${messageCounter}`,
        createdAt: data.createdAt ?? Date.now(),
        ...data,
      };
      const existing = messages.get(row.conversationId) ?? [];
      existing.push(row);
      messages.set(row.conversationId, existing);
      return { ...row };
    }),
    deleteMessage: vi.fn(async (id: string) => {
      for (const [conversationId, rows] of messages.entries()) {
        const next = rows.filter((message) => message.id !== id);
        if (next.length !== rows.length) {
          messages.set(conversationId, next);
          return true;
        }
      }
      return false;
    }),
    getMessages: vi.fn(async (conversationId: string) => {
      return (messages.get(conversationId) ?? []).map((message) => ({ ...message }));
    }),
    getPendingInterruptForTurn: vi.fn(async () => null),
    resolveInterrupt: vi.fn(async () => undefined),
    createWebhook: vi.fn(async (data: {
      id: string;
      agentId: string;
      url: string;
      events: string[];
      secret?: string | null;
      createdAt: number;
      updatedAt: number;
    }) => {
      const row: WebhookRow = {
        ...data,
        secret: data.secret ?? null,
        active: true,
      };
      webhooks.set(row.id, row);
      return { ...row };
    }),
    listWebhooks: vi.fn(async (agentId: string) => {
      return Array.from(webhooks.values())
        .filter((hook) => hook.agentId === agentId && hook.active)
        .map((hook) => ({ ...hook }));
    }),
    getWebhookForAgent: vi.fn(async (webhookId: string, agentId: string) => {
      const hook = webhooks.get(webhookId);
      return hook?.agentId === agentId ? { ...hook } : undefined;
    }),
    deleteWebhookForAgent: vi.fn(async (webhookId: string, agentId?: string) => {
      const hook = webhooks.get(webhookId);
      if (!hook || (agentId && hook.agentId !== agentId)) {
        return false;
      }
      return webhooks.delete(webhookId);
    }),
    updateWebhookForAgent: vi.fn(async (
      webhookId: string,
      agentId: string,
      data: { url: string; events: string[]; secret?: string | null },
    ) => {
      const hook = webhooks.get(webhookId);
      if (!hook || hook.agentId !== agentId) {
        return undefined;
      }
      const updated = {
        ...hook,
        url: data.url,
        events: data.events,
        secret: data.secret ?? null,
        updatedAt: Date.now(),
      };
      webhooks.set(webhookId, updated);
      return { ...updated };
    }),
    enqueueCallback: vi.fn(async (data: CallbackOutboxInsert) => {
      const row = {
        claimedAt: null,
        claimExpiresAt: null,
        ...data,
        eventSeq: data.eventSeq ?? null,
        turnId: data.turnId ?? null,
        lastAttemptAt: data.lastAttemptAt ?? null,
        lastError: data.lastError ?? null,
        deliveredAt: data.deliveredAt ?? null,
      } as CallbackOutboxRow;
      callbackOutbox.set(row.id, row);
      return { ...row };
    }),
    claimPendingCallbacks: vi.fn(async (limit: number, beforeTime: number) => {
      return Array.from(callbackOutbox.values())
        .filter((row) => row.status === 'pending' && row.nextAttemptAt <= beforeTime)
        .slice(0, limit)
        .map((row) => ({ ...row }));
    }),
    markCallbackDelivered: vi.fn(async (id: string) => {
      const row = callbackOutbox.get(id);
      if (!row) return;
      callbackOutbox.set(id, { ...row, status: 'delivered', deliveredAt: Date.now() });
    }),
    markCallbackFailed: vi.fn(async (id: string, error: string, nextAttemptAt?: number) => {
      const row = callbackOutbox.get(id);
      if (!row) return;
      const attempts = row.attempts + 1;
      callbackOutbox.set(id, {
        ...row,
        attempts,
        lastAttemptAt: Date.now(),
        lastError: error,
        nextAttemptAt: nextAttemptAt ?? Date.now(),
        status: attempts >= row.maxAttempts ? 'failed' : 'pending',
      });
    }),
    createTurnWithSecretEnvelope: vi.fn(async (
      data: Record<string, unknown>,
      secretEnvelope?: { iv: string; ciphertext: string; authTag: string },
    ) => {
      const id = typeof data.id === 'string' ? data.id : `turn-${Date.now()}`;
      const row = {
        id,
        ...data,
        sandboxSessionId: `sandbox-${id}`,
        startedAt: Date.now(),
        completedAt: null,
        error: null,
      };
      turns.set(id, row as unknown as TurnRow);
      if (secretEnvelope) {
        turnSecretEnvelopes.set(id, {
          turnId: id,
          ...secretEnvelope,
          createdAt: Date.now(),
        });
      }
      return row;
    }),
    getTurnSecretEnvelope: vi.fn(async (turnId: string) =>
      turnSecretEnvelopes.get(turnId)),
    updateTurn: vi.fn(async () => undefined),
    finalizeTurnIfOpen: vi.fn(async () => true),
    getTurn: vi.fn(async (id: string) => {
      const row = turns.get(id);
      return row ? { ...row } : undefined;
    }),
    getTurnsByAgent: vi.fn(async () => []),
    getActiveTurns: vi.fn(async () => []),
    _stores: {
      agents,
      webhooks,
      conversations,
      messages,
      turns,
      turnSecretEnvelopes,
      callbackOutbox,
    },
  };

  return db as unknown as DatabaseRepository & typeof db;
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createMockSessionManager(): SandboxSessionManager {
  return {
    ensureSession: vi.fn(),
    deliverTurn: vi.fn(),
    killSession: vi.fn(),
    findSessionById: vi.fn(),
    startTurn: vi.fn(),
    completeTurn: vi.fn(),
    cancelCurrentTurn: vi.fn(() => true),
    getAbortSignal: vi.fn(),
    checkConcurrencyLimit: vi.fn(),
    getTurn: vi.fn(),
    getActiveTurns: vi.fn(() => []),
    getTurnsByAgent: vi.fn(() => []),
  } as unknown as SandboxSessionManager;
}

function createTurnStartupServiceStub(): TurnStartupService {
  return new TurnStartupService({
    logger: console,
    turnSecretEnvelopeCodec: TEST_TURN_SECRET_CODEC,
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

async function createWebhookRelayRuntime(
  db: ReturnType<typeof createMockDb>,
  callbackDispatcher: Pick<CallbackDispatcher, 'enqueue'>,
): Promise<{ eventBus: TypedEventBus; runner: SpineConsumerRunner }> {
  const rows: EventFrameRow[] = [];
  const cursors = new Map<string, number>();
  let seq = 0;
  const persistFrames = async (frames: Array<Omit<EventFrameRow, 'seq' | 'createdAt'>>) =>
    frames.map((frame) => {
      seq += 1;
      rows.push({
        ...frame,
        seq,
        createdAt: Date.now(),
        turnId: frame.turnId ?? null,
        conversationId: frame.conversationId ?? null,
        sourceType: frame.sourceType ?? null,
        sourcePayload: frame.sourcePayload ?? null,
      });
      return seq;
    });

  const relayDb = Object.assign(db, {
    saveEventBatch: vi.fn(persistFrames),
    saveTerminalEventBatch: vi.fn(persistFrames),
    getFramesSince: vi.fn(async () => [] as EventFrameRow[]),
    getTurnFrames: vi.fn(async () => [] as EventFrameRow[]),
    getSourceEventsSince: vi.fn(async (afterSeq: number, limit = 1_000) =>
      rows.filter((row) => row.seq > afterSeq && row.sourceType).slice(0, limit)),
    getSpineCursor: vi.fn(async (consumer: string) => cursors.get(consumer) ?? 0),
    advanceSpineCursor: vi.fn(async (consumer: string, lastSeq: number) => {
      const nextSeq = Math.max(cursors.get(consumer) ?? 0, lastSeq);
      cursors.set(consumer, nextSeq);
      return { consumer, lastSeq: nextSeq, updatedAt: Date.now() };
    }),
  }) as DatabaseRepository & typeof db;

  const canonicalLog = new CanonicalLog({
    db: relayDb,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const eventBus = new TypedEventBus({
    persistEvent: async (type, _agentId, payload, parsedPayload, context) => {
      await canonicalLog.ingest(
        type,
        parsedPayload ?? toRecord(JSON.parse(payload) as unknown),
        context,
      );
    },
  });
  const runner = new SpineConsumerRunner({
    canonicalLog,
    db: relayDb,
    consumers: [createWebhookRelaySpineConsumer({ db: relayDb, callbackDispatcher })],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rescanIntervalMs: 60_000,
  });
  await runner.start();
  return { eventBus, runner };
}

async function buildApp(options?: {
  db?: ReturnType<typeof createMockDb>;
  eventBus?: TypedEventBus;
  sessionManager?: SandboxSessionManager;
  agentTurnService?: AgentTurnService;
}): Promise<{
  app: FastifyInstance;
  db: ReturnType<typeof createMockDb>;
  eventBus: TypedEventBus;
  sessionManager: SandboxSessionManager;
  agentTurnService: AgentTurnService;
}> {
  const db = options?.db ?? createMockDb();
  const eventBus = options?.eventBus ?? new TypedEventBus();
  const sessionManager = options?.sessionManager ?? createMockSessionManager();
  const agentTurnService = options?.agentTurnService ?? ({
    executeTurn: vi.fn(async () => {}),
  } as unknown as AgentTurnService);
  const turnStartupService = createTurnStartupServiceStub();
  turnStartupService.configureExecution({
    db,
    eventBus,
    sessionManager,
    agentTurnService,
  });

  const app = Fastify();
  const configSchema = z.object({ model: z.string().min(1) }).passthrough();
  await app.register(agentRoutes, {
    prefix: '/api/agents',
    db,
    sse: new SSEManager(),
    interrupts: new InterruptManager() as unknown as InterruptManager,
    sessionManager,
    harnessSchemas: { langgraph: configSchema },
    turnStartupService,
    eventBus,
  });
  await app.ready();

  return { app, db, eventBus, sessionManager, agentTurnService };
}

function createHttpAgent(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'pilot-agent',
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-test' },
    systemPrompt: 'Test agent',
    tools: ['read_file'],
    ...overrides,
  };
}

function getDeliveredBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) => {
    const init = (call[1] ?? {}) as RequestInit & { headers?: Record<string, string> };
    return {
      url: call[0],
      eventType: init.headers?.['X-Event-Type'],
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    };
  });
}

describe('Pilot integration', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  describe('agent registration with HTTP tools and webhooks', () => {
    it('registers an agent with separate HTTP tools and manages webhook registration', async () => {
      const system = await buildApp();
      app = system.app;

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: 'Pilot Agent',
          harness: 'langgraph',
          harnessConfig: { provider: 'openai', model: 'gpt-4o' },
          systemPrompt: 'Test Pilot integration',
          tools: ['read_file'],
          httpTools: [{
            name: 'remote-search',
            description: 'Search a Pilot API',
            endpoint: 'https://api.example.com/search',
            method: 'POST',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          }],
        },
      });

      expect(createResponse.statusCode).toBe(201);
      expect(createResponse.json()).toEqual(expect.objectContaining({
        id: 'agent-1',
        tools: ['read_file'],
        httpTools: [{
          name: 'remote-search',
          description: 'Search a Pilot API',
          endpoint: 'https://api.example.com/search',
          method: 'POST',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        }],
        metadata: null,
      }));

      const webhookResponse = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/webhooks',
        payload: {
          url: 'https://hooks.example/pilot',
          events: ['turn.started', 'turn.completed', 'tool_call.started'],
          secret: 'pilot-test-secret',
        },
      });

      expect(webhookResponse.statusCode).toBe(201);

      const listResponse = await app.inject({
        method: 'GET',
        url: '/api/agents/agent-1/webhooks',
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual([
        expect.objectContaining({
          agentId: 'agent-1',
          url: 'https://hooks.example/pilot',
          events: ['turn.started', 'turn.completed', 'tool_call.started'],
        }),
      ]);
    });

    it('rejects sandbox runtime control variables from per-turn sandboxSecrets', async () => {
      const system = await buildApp();
      app = system.app;

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: 'Pilot Agent',
          harness: 'langgraph',
          harnessConfig: { provider: 'openai', model: 'gpt-4o' },
          systemPrompt: 'Test Pilot integration',
          tools: [],
        },
      });
      expect(createResponse.statusCode).toBe(201);

      const startResponse = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/turns',
        payload: {
          task: 'Attempt runtime credential override',
          sandboxSecrets: {
            STABLEHAND_CALLBACK_TOKEN: 'forged-token',
          },
        },
      });

      expect(startResponse.statusCode).toBe(400);
      expect(startResponse.json()).toEqual({
        error: 'sandboxSecrets.STABLEHAND_CALLBACK_TOKEN: Secret key is reserved by the sandbox runtime',
      });
      expect(system.agentTurnService.executeTurn).not.toHaveBeenCalled();
    });
  });

  describe('HTTP tool resolution', () => {
    it('maps stored agent HTTP tool metadata to endpoint configs', () => {
      expect(mapAgentHttpToolsToConfigs(createHttpAgent({
        metadata: {
          httpTools: [{
            name: 'remote-search',
            description: 'Search a remote Pilot endpoint',
            endpoint: 'https://api.example.com/search',
            method: 'PATCH',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            headers: { 'X-Tenant': 'pilot' },
            timeoutMs: 1_500,
            authentication: { type: 'bearer', secretName: 'PILOT_API_KEY' },
          }],
        },
      }))).toEqual([{
        name: 'remote-search',
        url: 'https://api.example.com/search',
        method: 'PATCH',
        description: 'Search a remote Pilot endpoint',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        headers: { 'X-Tenant': 'pilot' },
        timeoutMs: 1_500,
        authentication: { type: 'bearer', secretName: 'PILOT_API_KEY' },
      }]);
    });

    it('returns an empty array when an agent has no HTTP tools', () => {
      expect(mapAgentHttpToolsToConfigs(createHttpAgent())).toEqual([]);
    });

    it('gracefully skips malformed HTTP tool entries', () => {
      expect(mapAgentHttpToolsToConfigs(createHttpAgent({
        metadata: {
          httpTools: [
            { name: 'valid', description: 'Valid tool', endpoint: 'https://api.example.com/valid' },
            { name: 'missing-description', endpoint: 'https://api.example.com/bad' },
            'not-an-object',
            { description: 'Missing name', endpoint: 'https://api.example.com/bad-2' },
          ],
        },
      }))).toEqual([{
        name: 'valid',
        url: 'https://api.example.com/valid',
        method: 'POST',
        description: 'Valid tool',
      }]);
    });
  });

  describe('cancel run triggers callbacks', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
      } as Response));
    });

    it('dispatches a run, emits tool callbacks, and delivers cancelled completion callbacks', async () => {
      const db = createMockDb();
      const callbackDispatcher = new CallbackDispatcher(db);
      callbackDispatcher.fetchFn = fetchMock;
      const webhookRuntime = await createWebhookRelayRuntime(db, callbackDispatcher);
      const { eventBus } = webhookRuntime;

      const sessionManager = createMockSessionManager();
      const cancelSessionSpy = vi.spyOn(sessionManager, 'cancelCurrentTurn');
      const agentTurnService = {
        executeTurn: vi.fn(async (params: { agentId: string; turnId: string; conversationId: string }) => {
          eventBus.emit('tool_call.started', {
            turnId: params.turnId,
            agentId: params.agentId,
            conversationId: params.conversationId,
            toolCallId: 'tool-1',
            toolName: 'remote-search',
            args: { query: 'pilot shipment 42' },
            timestamp: 222,
          });
          return new Promise<void>(() => {});
        }),
      } as unknown as AgentTurnService;

      const system = await buildApp({ db, eventBus, sessionManager, agentTurnService });
      app = system.app;

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: {
          name: 'Pilot Agent',
          harness: 'langgraph',
          harnessConfig: { provider: 'openai', model: 'gpt-4o' },
          systemPrompt: 'Execute Pilot dispatches',
          tools: ['read_file'],
          httpTools: [{
            name: 'remote-search',
            description: 'Search Pilot over HTTP',
            endpoint: 'https://api.example.com/search',
          }],
        },
      });
      expect(createResponse.statusCode).toBe(201);

      const webhookResponse = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/webhooks',
        payload: {
          url: 'https://hooks.example/pilot',
          events: ['turn.started', 'turn.completed', 'tool_call.started'],
          secret: 'pilot-test-secret',
        },
      });
      expect(webhookResponse.statusCode).toBe(201);

      const startResponse = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/turns',
        payload: {
          task: 'Dispatch Pilot order sync',
          sandboxSecrets: {
            PILOT_SERVICE_TOKEN: 'runtime-token',
            PILOT_API_BASE: 'http://api:3000',
          },
        },
      });

      expect(startResponse.statusCode).toBe(201);
      expect(agentTurnService.executeTurn).toHaveBeenCalledTimes(1);
      expect(agentTurnService.executeTurn).toHaveBeenCalledWith(expect.objectContaining({
        turnSecrets: {
          PILOT_SERVICE_TOKEN: 'runtime-token',
          PILOT_API_BASE: 'http://api:3000',
        },
      }));

      const { turnId } = startResponse.json() as { turnId: string; conversationId: string };

      await flushEvents();
      await callbackDispatcher.processPending();

      const preCancelDeliveries = getDeliveredBodies(fetchMock);
      // turn.started is emitted by sessionManager.startTurn() which is mocked in this test
      // and doesn't fire events on the eventBus. Only tool_call.started (from executeTurn mock) is delivered.
       expect(preCancelDeliveries).toEqual(expect.arrayContaining([
         expect.objectContaining({
           eventType: 'tool_call.started',
           body: expect.objectContaining({
             turnId,
             toolName: 'remote-search',
             args: { query: 'pilot shipment 42' },
           }),
         }),
       ]));

      const cancelResponse = await app.inject({
        method: 'POST',
        url: `/api/agents/agent-1/turns/${turnId}/cancel`,
      });

      expect(cancelResponse.statusCode, JSON.stringify(cancelResponse.json())).toBe(200);
      expect(cancelSessionSpy).toHaveBeenCalledWith(`sandbox-${turnId}`, turnId);

      eventBus.emit('turn.completed', {
        turnId,
        sandboxSessionId: `sandbox-${turnId}`,
        agentId: 'agent-1',
        conversationId: 'conv-1',
        status: 'cancelled' as const,
        durationMs: 100,
        timestamp: Date.now(),
      });

      await flushEvents();
      await callbackDispatcher.processPending();

      const completedDeliveries = getDeliveredBodies(fetchMock).filter((entry) => entry.eventType === 'turn.completed');
      expect(completedDeliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          body: expect.objectContaining({
            turnId,
            sandboxSessionId: `sandbox-${turnId}`,
            agentId: 'agent-1',
            status: 'CANCELLED',
          }),
        }),
      ]));
      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.example/pilot',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'X-Event-Type': 'turn.completed' }),
        }),
      );
      webhookRuntime.runner.stop();
    });
  });

  describe('webhook CRUD lifecycle', () => {
    it('creates, lists, deletes, and validates webhook lifecycle behavior', async () => {
      const system = await buildApp({
        db: createMockDb({
          agents: [createAgentRow()],
        }),
      });
      app = system.app;

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/webhooks',
        payload: {
          url: 'https://hooks.example/lifecycle',
          events: ['turn.completed'],
          secret: 'pilot-test-secret',
        },
      });
      expect(createResponse.statusCode).toBe(201);

      const createdWebhook = createResponse.json() as WebhookRow;

      const firstList = await app.inject({
        method: 'GET',
        url: '/api/agents/agent-1/webhooks',
      });
      expect(firstList.statusCode).toBe(200);
      expect(firstList.json()).toEqual([
        expect.objectContaining({
          id: createdWebhook.id,
          url: 'https://hooks.example/lifecycle',
          events: ['turn.completed'],
        }),
      ]);

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/api/agents/agent-1/webhooks/${createdWebhook.id}`,
      });
      expect(deleteResponse.statusCode).toBe(204);

      const secondList = await app.inject({
        method: 'GET',
        url: '/api/agents/agent-1/webhooks',
      });
      expect(secondList.statusCode).toBe(200);
      expect(secondList.json()).toEqual([]);

      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/api/agents/agent-1/webhooks',
        payload: {
          url: 'https://hooks.example/invalid',
          events: ['turn.completed', 'run.invalid'],
          secret: 'pilot-test-secret',
        },
      });
      expect(invalidResponse.statusCode).toBe(400);
      expect(invalidResponse.json()).toMatchObject({
        error: 'Invalid webhook definition',
        issues: [expect.objectContaining({ path: 'events.1' })],
      });

      const missingDeleteResponse = await app.inject({
        method: 'DELETE',
        url: '/api/agents/agent-1/webhooks/does-not-exist',
      });
      expect(missingDeleteResponse.statusCode).toBe(404);
      expect(missingDeleteResponse.json()).toEqual({ error: 'Webhook not found' });
    });
  });
});
