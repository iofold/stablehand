import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentRoutes } from '../routes/agents.js';
import { createServer } from '../server.js';
import { SessionTurnService } from '../session-turn-service.js';
import type { SessionEvent } from '../session-turn-service.js';
import { mapAgentHttpToolsToConfigs, validateAgentHttpToolsConfig } from '../http-tools.js';
import type { AgentSessionService } from '../agent-session-service.js';
import type { RunStartupService } from '../run-startup-service.js';
import type { SandboxSessionManager } from '../sandbox-session-manager.js';
import type { SSEManager } from '../sse.js';
import type { InterruptManager } from '../interrupt.js';
import type { DatabaseRepository } from '../../database/repository.js';
import { TypedEventBus } from '../../events/bus.js';
import type { AgentDefinition, Message } from '../../types.js';
import { DefaultToolRegistry } from '../../tool/registry.js';

function createTestBus(options?: ConstructorParameters<typeof TypedEventBus>[0]): TypedEventBus {
  return new TypedEventBus(options);
}

function createHarnessRegistry() {
  const configSchema = z.object({ model: z.string().min(1) }).passthrough();
  const harness = {
    name: 'langgraph',
    configSchema,
    openSession: vi.fn(),
  };
  return {
    register: vi.fn(),
    get: vi.fn(() => harness),
    getConfigSchema: vi.fn(() => configSchema),
    list: vi.fn(() => ['langgraph']),
  };
}

function createRunStartupServiceStub(): RunStartupService {
  return {
    prepareRunStart: vi.fn(),
    launchPreparedRun: vi.fn(),
  } as unknown as RunStartupService;
}

let mockStartRunIterator: AsyncGenerator<unknown>;

vi.mock('@connectrpc/connect', () => ({
  createClient: vi.fn(() => ({
    kill: vi.fn(async () => ({ success: true })),
    startRun: vi.fn((_req: Record<string, unknown>) => {
      return mockStartRunIterator;
    }),
  })),
}));

vi.mock('@connectrpc/connect-node', () => ({
  createConnectTransport: vi.fn(() => ({})),
}));

function createRouteDbMock(): {
  db: DatabaseRepository;
  createAgent: ReturnType<typeof vi.fn>;
  getAgent: ReturnType<typeof vi.fn>;
  updateAgent: ReturnType<typeof vi.fn>;
} {
  const createAgent = vi.fn();
  const getAgent = vi.fn();
  const updateAgent = vi.fn();

  return {
    db: {
      createAgent,
      getAgent,
      updateAgent,
    } as unknown as DatabaseRepository,
    createAgent,
    getAgent,
    updateAgent,
  };
}

async function buildAgentsApp(db: DatabaseRepository, toolRegistry?: DefaultToolRegistry) {
  const app = Fastify();
  const sse = {
    getActiveAgentIds: vi.fn(() => []),
    getClientCount: vi.fn(() => 0),
    getLastActivity: vi.fn(() => null),
  } as unknown as SSEManager;
  const interrupts = {} as unknown as InterruptManager;
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
  const agentSessionService = {
    executeSession: vi.fn(),
  } as unknown as AgentSessionService;

  await app.register(agentRoutes, {
    db,
    sse,
    interrupts,
    sessionManager,
    harnessRegistry: createHarnessRegistry() as never,
    agentSessionService,
    runStartupService: createRunStartupServiceStub(),
    toolRegistry,
  });
  await app.ready();
  return app;
}

function createAgentDef(overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    name: 'agent-1',
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-4o' },
    systemPrompt: 'You are a test agent',
    tools: ['read_file'],
    ...overrides,
  };
}

function createMessages(): Message[] {
  return [{
    id: 'msg-1',
    agentId: 'agent-1',
    role: 'user',
    content: 'Hello',
    createdAt: new Date(),
  }];
}

const originalFetch = globalThis.fetch;
const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('HTTP tool registration', () => {
  beforeEach(() => {
    mockStartRunIterator = (async function* () {
      yield {
        sequence: BigInt(1),
        runId: 'run-1',
        event: { event: { case: 'done' as const, value: { result: 'ok', interrupted: false } } },
      };
    })();
    globalThis.fetch = vi.fn(async () => ({ ok: true } as Response));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('stores POST httpTools in metadata and appends tool names', async () => {
    const { db, createAgent } = createRouteDbMock();
    createAgent.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'agent-1',
      name: input.name,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      description: input.description,
      metadata: input.metadata,
      harness: input.harness,
      harnessConfig: input.harnessConfig,
      workspaceDir: null,
    }));

    const app = await buildAgentsApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        name: 'Agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        systemPrompt: 'test',
        tools: ['read_file'],
        httpTools: [{
          name: 'remote-search',
          description: 'Search remote API',
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

    expect(response.statusCode).toBe(201);
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({
      tools: ['read_file', 'remote-search'],
      metadata: {
        httpTools: [{
          name: 'remote-search',
          description: 'Search remote API',
          endpoint: 'https://api.example.com/search',
          method: 'POST',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        }],
      },
    }));

    await app.close();
  });

  it('rejects invalid POST httpTools', async () => {
    const { db, createAgent } = createRouteDbMock();
    const app = await buildAgentsApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        name: 'Agent',
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-4o' },
        systemPrompt: 'test',
        tools: ['read_file'],
        httpTools: [{
          name: 'broken-tool',
          description: 'Missing endpoint',
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'HTTP tool requires name, description, and endpoint' });
    expect(createAgent).not.toHaveBeenCalled();

    await app.close();
  });

  it('updates PUT httpTools and refreshes merged tool names', async () => {
    const { db, getAgent, updateAgent } = createRouteDbMock();
    getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
      systemPrompt: 'test',
      tools: ['read_file', 'old-http-tool'],
      metadata: {
        httpTools: [{
          name: 'old-http-tool',
          description: 'Old tool',
          endpoint: 'https://old.example.com',
        }],
      },
    });
    updateAgent.mockImplementation(async (_id: string, input: Record<string, unknown>) => ({
      id: 'agent-1',
      name: 'Agent',
      harness: typeof input.harness === 'string' ? input.harness : 'langgraph',
      harnessConfig: typeof input.harnessConfig === 'string'
        ? input.harnessConfig
        : JSON.stringify(input.harnessConfig ?? { provider: 'openai', model: 'gpt-4o' }),
      systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : 'test',
      tools: Array.isArray(input.tools) ? input.tools : ['read_file', 'old-http-tool'],
      metadata: input.metadata ?? null,
      description: input.description ?? null,
      workspaceDir: null,
    }));

    const app = await buildAgentsApp(db);
    const httpTools = [{
      name: 'new-http-tool',
      description: 'New tool',
      endpoint: 'https://new.example.com',
      method: 'GET',
    }];

    const response = await app.inject({
      method: 'PUT',
      url: '/agent-1',
      payload: { httpTools },
    });

    expect(response.statusCode).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      tools: ['read_file', 'new-http-tool'],
      metadata: { httpTools },
    }));

    await app.close();
  });

  it('auto-registers existing agent HTTP tools on server startup', async () => {
    const toolRegistry = new DefaultToolRegistry();
    const db = {
      listAgents: vi.fn(async () => ([{
        id: 'agent-1',
        name: 'Agent',
        harness: 'langgraph',
        harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
        systemPrompt: 'test',
        tools: ['remote-search'],
        metadata: {
          httpTools: [{
            name: 'remote-search',
            description: 'Search remote API',
            endpoint: 'https://api.example.com/search',
          }],
        },
      }])),
    } as unknown as DatabaseRepository;

    const app = await createServer({
      db,
      agentSessionService: { executeSession: vi.fn() } as unknown as AgentSessionService,
      runStartupService: createRunStartupServiceStub(),
      toolDefinitionRegistry: toolRegistry,
    });

    expect(app.toolDefinitionRegistry).toBe(toolRegistry);
    expect(toolRegistry.getTool('remote-search')).toEqual(expect.objectContaining({
      name: 'remote-search',
      description: 'Search remote API',
    }));

    await app.close();
  });

  it('maps stored httpTools metadata to HttpEndpointConfig values', () => {
    const configs = mapAgentHttpToolsToConfigs(createAgentDef({
      metadata: {
        httpTools: [{
          name: 'remote-search',
          description: 'Search remote API',
          endpoint: 'https://api.example.com/search',
          method: 'PATCH',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          headers: { 'X-Test': '1' },
          timeout: 1234,
          authentication: { type: 'bearer', secretName: 'REMOTE_API_KEY' },
        }],
      },
    }));

    expect(configs).toEqual([{ 
      name: 'remote-search',
      url: 'https://api.example.com/search',
      method: 'PATCH',
      description: 'Search remote API',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      headers: { 'X-Test': '1' },
      timeout: 1234,
      authentication: { type: 'bearer', secretName: 'REMOTE_API_KEY' },
    }]);
  });

  it('rejects invalid HTTP tool methods deterministically', () => {
    const httpTools = [{
      name: 'remote-search',
      description: 'Search remote API',
      endpoint: 'https://api.example.com/search',
      method: 'TRACE',
    }];

    expect(validateAgentHttpToolsConfig(httpTools)).toBe('Invalid HTTP tool method: TRACE');
    expect(() => mapAgentHttpToolsToConfigs(createAgentDef({ metadata: { httpTools } }))).toThrow(
      /Invalid HTTP tool method: TRACE/,
    );
  });

  it('rejects duplicate HTTP tool names deterministically', () => {
    expect(validateAgentHttpToolsConfig([
      { name: 'remote-search', description: 'Search A', endpoint: 'https://api.example.com/a' },
      { name: 'remote-search', description: 'Search B', endpoint: 'https://api.example.com/b' },
    ])).toBe('Duplicate HTTP tool name: remote-search');
  });

  it('routes executeSessionTurn through sessionManager and passes agentDef with http tools', async () => {
    const agentDef = createAgentDef({
      tools: ['read_file', 'remote-search'],
      metadata: {
        httpTools: [{
          name: 'remote-search',
          description: 'Search remote API',
          endpoint: 'https://api.example.com/search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        }],
      },
    });

    const capturedAgentDef: AgentDefinition[] = [];
    const sessionManager = {
      ensureSession: vi.fn(async (_convId, def) => {
        capturedAgentDef.push(def);
        return { sessionId: 'session-1' };
      }),
      deliverTurn: async function* (): AsyncGenerator<SessionEvent> {},
      killSession: vi.fn(async () => {}),
      suspendSession: vi.fn(async () => {}),
    } as unknown as SandboxSessionManager;

    const service = new SessionTurnService({
      sessionManager,
      eventBus: createTestBus(),
      logger: silentLogger,
    });

    const events: string[] = [];
    for await (const event of service.executeSessionTurn(agentDef, 'conv-1', createMessages(), 'turn-1')) {
      events.push(event.type);
    }

    expect(sessionManager.ensureSession).toHaveBeenCalledWith('conv-1', agentDef, agentDef.name);
    expect(capturedAgentDef[0]).toBe(agentDef);
    expect(capturedAgentDef[0].tools).toContain('remote-search');
    expect(capturedAgentDef[0].metadata?.httpTools).toBeDefined();
  });
});
