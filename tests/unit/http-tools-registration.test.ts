import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import type { SecretProvider } from '../../packages/ctxmill/src/secrets/types.js';
import type { ToolContext } from '@ctxmill/sandbox-daemon';
import { DefaultToolRegistry } from '../../packages/ctxmill/src/tool/registry.js';
import { HTTPToolProvider } from '../../packages/ctxmill/src/tool/providers/http.js';
import {
  getAgentHttpToolProviderName,
  mapAgentHttpToolsToConfigs,
  registerAgentHttpTools,
  registerExistingAgentHttpTools,
} from '../../packages/ctxmill/src/orchestrator/http-tools.js';

type RegistrationAgent = Parameters<typeof registerAgentHttpTools>[1];
type AgentRepository = Parameters<typeof registerExistingAgentHttpTools>[0];

const mockCtx: ToolContext = {
  agentId: 'test-agent',
  conversationId: 'test-conv',
  instanceId: 'run-123',
  workspaceDir: '/tmp/test',
};

function createHttpTool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'search-api',
    description: 'Search external API',
    endpoint: 'https://example.com/search',
    method: 'POST',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    headers: {
      'X-Test': 'true',
    },
    timeout: 5000,
    authentication: {
      type: 'bearer',
      secretName: 'API_TOKEN',
    },
    ...overrides,
  };
}

function createAgentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'Search Agent',
    model: 'gpt-5.4-mini',
    harness: 'langgraph',
    systemPrompt: 'You are helpful.',
    tools: [],
    metadata: {
      httpTools: [createHttpTool()],
    },
    ...overrides,
  };
}

function createRegistrationAgent(overrides: Partial<RegistrationAgent> = {}): RegistrationAgent {
  return {
    id: 'agent-1',
    name: 'Search Agent',
    metadata: {
      httpTools: [createHttpTool()],
    },
    ...overrides,
  };
}

function createSecretProvider(overrides: Partial<SecretProvider> = {}): SecretProvider {
  return {
    get: () => null,
    set: () => {},
    delete: () => {},
    list: () => [],
    ...overrides,
  };
}

function createFetchResponse(body = '{"ok":true}') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn(async () => body),
  };
}

describe('http tools registration lifecycle', () => {
  let registry: DefaultToolRegistry;

  beforeEach(() => {
    registry = new DefaultToolRegistry();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.API_TOKEN;
  });

  it('getAgentHttpToolProviderName returns http-{agentId}', () => {
    expect(getAgentHttpToolProviderName('agent-123')).toBe('http-agent-123');
  });

  it('mapAgentHttpToolsToConfigs extracts all supported fields', () => {
    const agent = createAgentDefinition();

    expect(mapAgentHttpToolsToConfigs(agent)).toEqual([
      {
        name: 'search-api',
        url: 'https://example.com/search',
        method: 'POST',
        description: 'Search external API',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
        headers: {
          'X-Test': 'true',
        },
        timeout: 5000,
        authentication: {
          type: 'bearer',
          secretName: 'API_TOKEN',
        },
      },
    ]);
  });

  it('mapAgentHttpToolsToConfigs applies defaults when optional fields are missing', () => {
    const agent = createAgentDefinition({
      metadata: {
        httpTools: [
          createHttpTool({
            method: undefined,
            inputSchema: undefined,
            headers: undefined,
            timeout: undefined,
            authentication: undefined,
          }),
        ],
      },
    });

    expect(mapAgentHttpToolsToConfigs(agent)).toEqual([
      {
        name: 'search-api',
        url: 'https://example.com/search',
        method: 'POST',
        description: 'Search external API',
      },
    ]);
  });

  it('registerAgentHttpTools creates a provider named http-{agentId}', async () => {
    const addProviderSpy = vi.spyOn(registry, 'addProvider');

    await registerAgentHttpTools(registry, createRegistrationAgent());

    expect(addProviderSpy).toHaveBeenCalledTimes(1);
    expect(addProviderSpy.mock.calls[0]?.[0]).toBeInstanceOf(HTTPToolProvider);
    expect(addProviderSpy.mock.calls[0]?.[0].name).toBe('http-agent-1');
  });

  it('registerAgentHttpTools adds the provider to the registry and refreshes', async () => {
    const addProviderSpy = vi.spyOn(registry, 'addProvider');
    const refreshSpy = vi.spyOn(registry, 'refresh');

    await registerAgentHttpTools(registry, createRegistrationAgent());

    expect(addProviderSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(registry.listAll().map((tool) => tool.name)).toEqual(['search-api']);
    expect(registry.getProvider('search-api')?.name).toBe('http-agent-1');
  });

  it('registerAgentHttpTools replaces old provider tools on update', async () => {
    await registerAgentHttpTools(registry, createRegistrationAgent());

    await registerAgentHttpTools(registry, createRegistrationAgent({
      metadata: {
        httpTools: [
          createHttpTool({
            name: 'weather-api',
            description: 'Fetch weather',
            endpoint: 'https://example.com/weather',
          }),
        ],
      },
    }));

    expect(registry.listAll().map((tool) => tool.name)).toEqual(['weather-api']);
    expect(registry.getProvider('search-api')).toBeUndefined();
    expect(registry.getProvider('weather-api')?.name).toBe('http-agent-1');
  });

  it('registerExistingAgentHttpTools bulk-registers providers for all agents', async () => {
    const db = {
      listAgents: vi.fn(async () => [
        createRegistrationAgent({
          id: 'agent-1',
          metadata: {
            httpTools: [createHttpTool({ name: 'search-api' })],
          },
        }),
        createRegistrationAgent({
          id: 'agent-2',
          metadata: {
            httpTools: [createHttpTool({ name: 'weather-api' })],
          },
        }),
      ]),
    } satisfies AgentRepository;

    await registerExistingAgentHttpTools(db, registry);

    expect(db.listAgents).toHaveBeenCalledTimes(1);
    expect(registry.listAll().map((tool) => tool.name).sort()).toEqual(['search-api', 'weather-api']);
    expect(registry.getProvider('search-api')?.name).toBe('http-agent-1');
    expect(registry.getProvider('weather-api')?.name).toBe('http-agent-2');
  });

  it('registerAgentHttpTools is a no-op when agent metadata has no httpTools', async () => {
    const addProviderSpy = vi.spyOn(registry, 'addProvider');
    const refreshSpy = vi.spyOn(registry, 'refresh');

    await registerAgentHttpTools(registry, createRegistrationAgent({ metadata: {} }));

    expect(addProviderSpy).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(registry.listAll()).toHaveLength(0);
  });

  it('registerAgentHttpTools is a no-op when agent metadata has an empty httpTools array', async () => {
    const addProviderSpy = vi.spyOn(registry, 'addProvider');
    const refreshSpy = vi.spyOn(registry, 'refresh');

    await registerAgentHttpTools(registry, createRegistrationAgent({
      metadata: {
        httpTools: [],
      },
    }));

    expect(addProviderSpy).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(registry.listAll()).toHaveLength(0);
  });

  it('registerAgentHttpTools resolves provider secrets from SecretProvider', async () => {
    const fetchMock = vi.fn(async () => createFetchResponse());
    vi.stubGlobal('fetch', fetchMock);

    const secretProvider = createSecretProvider({
      list: vi.fn(() => ['API_TOKEN']),
      get: vi.fn(() => 'provider-secret'),
    });

    await registerAgentHttpTools(registry, createRegistrationAgent(), secretProvider);

    const provider = registry.getProvider('search-api');
    expect(provider).toBeDefined();

    await provider?.execute('search-api', { query: 'ctxmill' }, mockCtx);

    expect(secretProvider.list).toHaveBeenCalledWith('agent-1');
    expect(secretProvider.get).toHaveBeenCalledWith('agent-1', 'API_TOKEN');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/search',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer provider-secret',
        }),
      }),
    );
  });

  it('HTTPToolProvider fails closed when provider secrets are missing', async () => {
    const fetchMock = vi.fn(async () => createFetchResponse());
    vi.stubGlobal('fetch', fetchMock);
    process.env.API_TOKEN = 'env-secret';

    await registerAgentHttpTools(registry, createRegistrationAgent());

    const provider = registry.getProvider('search-api');
    expect(provider).toBeDefined();

    await expect(provider?.execute('search-api', { query: 'ctxmill' }, mockCtx)).rejects.toThrow(
      'HTTPToolProvider: missing secret "API_TOKEN" for tool "search-api"',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HTTPToolProvider can opt in to process.env fallback for provider secrets', async () => {
    const fetchMock = vi.fn(async () => createFetchResponse());
    vi.stubGlobal('fetch', fetchMock);
    process.env.API_TOKEN = 'env-secret';

    await registerAgentHttpTools(registry, createRegistrationAgent({
      metadata: {
        httpTools: [createHttpTool({
          authentication: {
            type: 'bearer',
            secretName: 'API_TOKEN',
            allowEnvFallback: true,
          },
        })],
      },
    }));

    const provider = registry.getProvider('search-api');
    expect(provider).toBeDefined();

    await provider?.execute('search-api', { query: 'ctxmill' }, mockCtx);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/search',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer env-secret',
        }),
      }),
    );
  });

  it('registerAgentHttpTools removes the old provider before adding a new one', async () => {
    await registerAgentHttpTools(registry, createRegistrationAgent());

    const removeProviderSpy = vi.spyOn(registry, 'removeProvider');
    const addProviderSpy = vi.spyOn(registry, 'addProvider');

    await registerAgentHttpTools(registry, createRegistrationAgent({
      metadata: {
        httpTools: [createHttpTool({ name: 'weather-api' })],
      },
    }));

    expect(removeProviderSpy).toHaveBeenCalledWith('http-agent-1');
    expect(addProviderSpy).toHaveBeenCalledTimes(1);
    expect(removeProviderSpy.mock.invocationCallOrder[0]).toBeLessThan(
      addProviderSpy.mock.invocationCallOrder[0] ?? 0,
    );
    expect(registry.listAll().map((tool) => tool.name)).toEqual(['weather-api']);
  });

  it('registerAgentHttpTools refreshes and clears tools when re-registering with no httpTools', async () => {
    const refreshSpy = vi.spyOn(registry, 'refresh');

    await registerAgentHttpTools(registry, createRegistrationAgent());
    await registerAgentHttpTools(registry, createRegistrationAgent({ metadata: {} }));

    expect(refreshSpy).toHaveBeenCalledTimes(2);
    expect(registry.listAll()).toHaveLength(0);
  });
});
