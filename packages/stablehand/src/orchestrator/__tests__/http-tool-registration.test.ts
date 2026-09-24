import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentRoutes } from '../routes/agents.js';
import { createServer } from '../server.js';
import { createSessionTurnExecutor } from '../session-turn-service.js';
import type { SessionEvent } from '../session-turn-service.js';
import { mapAgentHttpToolsToConfigs, validateAgentHttpToolsConfig, registerAgentHttpTools } from '../http-tools.js';
import type { TurnStartupService } from '../turn-startup-service.js';
import type { SandboxSessionManager } from '../sandbox-session-manager.js';
import { SSEManager } from '../sse.js';
import { InterruptManager } from '../interrupt.js';
import type { DatabaseRepository } from '../../database/repository.js';
import { TypedEventBus } from '../../events/bus.js';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';
import { DefaultToolRegistry } from '../../tool/registry.js';
import { createTestTurnStartupService } from './turn-startup-test-helper.js';

function createTestBus(options?: ConstructorParameters<typeof TypedEventBus>[0]): TypedEventBus {
  return new TypedEventBus(options);
}

function createHarnessSchemas() {
  const configSchema = z.object({ model: z.string().min(1) }).passthrough();
  return { langgraph: configSchema };
}

function createTurnStartupServiceStub(): TurnStartupService {
  return createTestTurnStartupService();
}

let mockStartRunIterator: AsyncGenerator<unknown>;

vi.mock('@connectrpc/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@connectrpc/connect')>();
  return {
    ...actual,
    createClient: vi.fn(() => ({
      kill: vi.fn(async () => ({ success: true })),
      startRun: vi.fn((_req: Record<string, unknown>) => {
        return mockStartRunIterator;
      }),
    })),
  };
});

vi.mock('@connectrpc/connect-node', () => ({
  createConnectTransport: vi.fn(() => ({})),
}));

function createRouteDbMock(): {
  db: DatabaseRepository;
  createAgent: ReturnType<typeof vi.fn>;
  deleteAgentCascade: ReturnType<typeof vi.fn>;
  getAgent: ReturnType<typeof vi.fn>;
  updateAgent: ReturnType<typeof vi.fn>;
} {
  const createAgent = vi.fn();
  const deleteAgentCascade = vi.fn();
  const getAgent = vi.fn();
  const updateAgent = vi.fn();
  const getActiveTurnsForAgent = vi.fn().mockResolvedValue([]);

  return {
    db: {
      createAgent,
      deleteAgentCascade,
      getAgent,
      getActiveTurnsForAgent,
      updateAgent,
    } as unknown as DatabaseRepository,
    createAgent,
    deleteAgentCascade,
    getAgent,
    updateAgent,
  };
}

function storedAgent(
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'agent-1',
    name: input.name ?? 'Agent',
    systemPrompt: input.systemPrompt ?? 'test',
    tools: input.tools ?? [],
    description: input.description ?? null,
    metadata: input.metadata ?? null,
    harness: input.harness ?? 'langgraph',
    harnessConfig: input.harnessConfig
      ?? JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
    workspaceDir: null,
    manifest: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function buildAgentsApp(
  db: DatabaseRepository,
  toolRegistry?: DefaultToolRegistry,
  eventBus?: TypedEventBus,
) {
  const app = Fastify();
  const sse = {
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
  await app.register(agentRoutes, {
    db,
    sse,
    interrupts,
    sessionManager,
    harnessSchemas: createHarnessSchemas(),
    turnStartupService: createTurnStartupServiceStub(),
    toolRegistry,
    eventBus,
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

  it('stores POST httpTools in metadata without merging definition names into references', async () => {
    const { db, createAgent } = createRouteDbMock();
    createAgent.mockImplementation(async (input: Record<string, unknown>) => storedAgent(input));

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
      tools: ['read_file'],
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

  it('registers POST httpTools before emitting agent.created', async () => {
    const { db, createAgent } = createRouteDbMock();
    createAgent.mockImplementation(async (input: Record<string, unknown>) => storedAgent(input));

    const toolRegistry = new DefaultToolRegistry();
    const eventBus = createTestBus();
    const toolRegisteredAtCreated: boolean[] = [];
    eventBus.on('agent.created', () => {
      toolRegisteredAtCreated.push(toolRegistry.getTool('remote-search') !== undefined);
    });

    const app = await buildAgentsApp(db, toolRegistry, eventBus);

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
        }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(toolRegisteredAtCreated).toEqual([true]);

    await app.close();
  });

  it('compensates agent creation when HTTP tool registration fails', async () => {
    const { db, createAgent, deleteAgentCascade } = createRouteDbMock();
    createAgent.mockImplementation(async (input: Record<string, unknown>) => storedAgent(input));
    const toolRegistry = new DefaultToolRegistry();
    vi.spyOn(toolRegistry, 'refresh').mockRejectedValueOnce(new Error('registry refresh failed'));
    const app = await buildAgentsApp(db, toolRegistry);

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        name: 'Atomic create',
        harness: 'langgraph',
        harnessConfig: { model: 'gpt-4o' },
        systemPrompt: 'test',
        tools: [],
        httpTools: [{
          name: 'remote-search',
          description: 'Search remote API',
          endpoint: 'https://api.example.com/search',
        }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(deleteAgentCascade).toHaveBeenCalledWith('agent-1');
    expect(toolRegistry.getTool('remote-search', 'agent-1')).toBeUndefined();
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
    expect(response.json()).toMatchObject({
      error: 'Invalid agent definition',
      code: 'invalid_agent_definition',
      issues: [expect.objectContaining({
        path: 'httpTools.0.endpoint',
      })],
    });
    expect(createAgent).not.toHaveBeenCalled();

    await app.close();
  });

  it('updates PATCH httpTools without mutating referenced tool names', async () => {
    const { db, getAgent, updateAgent } = createRouteDbMock();
    getAgent.mockResolvedValue(storedAgent({
      name: 'Agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
      systemPrompt: 'test',
      tools: ['read_file'],
      metadata: {
        httpTools: [{
          name: 'old-http-tool',
          description: 'Old tool',
          endpoint: 'https://old.example.com',
        }],
      },
    }));
    updateAgent.mockImplementation(async (_id: string, input: Record<string, unknown>) => storedAgent({
      name: 'Agent',
      harness: typeof input.harness === 'string' ? input.harness : 'langgraph',
      harnessConfig: typeof input.harnessConfig === 'string'
        ? input.harnessConfig
        : JSON.stringify(input.harnessConfig ?? { provider: 'openai', model: 'gpt-4o' }),
      systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : 'test',
      tools: Array.isArray(input.tools) ? input.tools : ['read_file'],
      metadata: input.metadata ?? null,
      description: input.description ?? null,
    }));

    const app = await buildAgentsApp(db);
    const httpTools = [{
      name: 'new-http-tool',
      description: 'New tool',
      endpoint: 'https://new.example.com',
      method: 'GET',
    }];

    const response = await app.inject({
      method: 'PATCH',
      url: '/agent-1',
      payload: { httpTools },
    });

    expect(response.statusCode).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      metadata: { httpTools },
    }));

    await app.close();
  });

  it('restores the prior agent and provider when HTTP tool update registration fails', async () => {
    const { db, getAgent, updateAgent } = createRouteDbMock();
    const original = storedAgent({
      name: 'Agent',
      tools: ['read_file'],
      metadata: {
        httpTools: [{
          name: 'old-http-tool',
          description: 'Old tool',
          endpoint: 'https://old.example.com',
        }],
      },
    });
    getAgent.mockResolvedValue(original);
    updateAgent
      .mockResolvedValueOnce(storedAgent({
        ...original,
        metadata: {
          httpTools: [{
            name: 'new-http-tool',
            description: 'New tool',
            endpoint: 'https://new.example.com',
          }],
        },
      }))
      .mockResolvedValueOnce(original);

    const toolRegistry = new DefaultToolRegistry();
    await registerAgentHttpTools(toolRegistry, original);
    const actualRefresh = toolRegistry.refresh.bind(toolRegistry);
    vi.spyOn(toolRegistry, 'refresh')
      .mockRejectedValueOnce(new Error('registry refresh failed'))
      .mockImplementation(actualRefresh);
    const app = await buildAgentsApp(db, toolRegistry);

    const response = await app.inject({
      method: 'PATCH',
      url: '/agent-1',
      payload: {
        httpTools: [{
          name: 'new-http-tool',
          description: 'New tool',
          endpoint: 'https://new.example.com',
        }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(updateAgent).toHaveBeenCalledTimes(2);
    expect(updateAgent.mock.calls[1]?.[1]).toMatchObject({
      name: 'Agent',
      tools: ['read_file'],
      metadata: original.metadata,
    });
    expect(toolRegistry.getTool('old-http-tool', 'agent-1')).toBeDefined();
    expect(toolRegistry.getTool('new-http-tool', 'agent-1')).toBeUndefined();
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
      turnStartupService: createTurnStartupServiceStub(),
      toolDefinitionRegistry: toolRegistry,
      eventBus: createTestBus(),
      harnessSchemas: createHarnessSchemas(),
      sse: new SSEManager(),
      interrupts: new InterruptManager(),
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
          timeoutMs: 1234,
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
      timeoutMs: 1234,
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

    const service = createSessionTurnExecutor({
      sessionManager,
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

describe('HTTP tool SSRF egress guard (wiring)', () => {
  it('blocks a registered HTTP tool from reaching the cloud metadata endpoint', async () => {
    const toolRegistry = new DefaultToolRegistry();
    await registerAgentHttpTools(toolRegistry, {
      id: 'agent-ssrf',
      name: 'agent-ssrf',
      metadata: {
        httpTools: [{
          name: 'metadata-probe',
          description: 'Attempts to read cloud metadata',
          endpoint: 'http://169.254.169.254/latest/meta-data/',
          method: 'GET',
        }],
      },
    });
    await toolRegistry.refresh();

    const tool = toolRegistry.getTool('metadata-probe', 'agent-ssrf');
    expect(tool).toBeDefined();

    await expect(
      tool!.handler({}, {
        agentId: 'agent-ssrf',
        conversationId: 'conv-1',
        turnId: 'turn-1',
        sandboxSessionId: 'sandbox-1',
        workspaceDir: '/tmp',
      }),
    ).rejects.toThrow(/blocked/i);
  });
});
