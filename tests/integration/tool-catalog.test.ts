import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

const VALID_AGENT = {
  name: 'test-agent',
  harness: 'langgraph',
  harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
  systemPrompt: 'You are a test agent.',
  tools: ['tool-a', 'tool-b'],
};

interface CatalogTool {
  name: string;
  description?: string;
  source: 'local' | 'mcp' | 'composio';
  inputSchema?: Record<string, unknown>;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortCatalog(tools: CatalogTool[]): CatalogTool[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

describe('GET /api/catalogs/tools', () => {
  let app: TestAppHandle['app'];
  let testApp: TestAppHandle | undefined;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'stablehand-tool-catalog-',
    });
    app = testApp.app;
  });

  afterAll(async () => {
    await testApp?.close();
  });

  async function createAgent(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { ...VALID_AGENT, ...overrides },
    });
  }

  async function getCatalog(url = '/api/catalogs/tools'): Promise<CatalogTool[]> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.json<CatalogTool[]>();
  }

  it('returns 200 with an array of tools', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/catalogs/tools',
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('returns name, description, source, and current inputSchema behavior for agent tools', async () => {
    const agentName = uniqueId('catalog-fields-agent');
    const toolName = uniqueId('catalog-fields-tool');

    const created = await createAgent({
      name: agentName,
      tools: [toolName],
    });

    expect(created.statusCode).toBe(201);

    const catalog = await getCatalog();
    const tool = catalog.find((item) => item.name === toolName);

    expect(tool).toBeDefined();
    expect(tool).toMatchObject({
      name: toolName,
      description: `Tool registered by agent ${agentName}`,
      source: 'local',
    });
    expect(tool?.inputSchema).toBeUndefined();
  });

  it('marks plain tool names as local', async () => {
    const toolName = uniqueId('local-tool');

    const created = await createAgent({
      name: uniqueId('local-agent'),
      tools: [toolName],
    });

    expect(created.statusCode).toBe(201);

    const catalog = await getCatalog();
    expect(catalog).toContainEqual(expect.objectContaining({ name: toolName, source: 'local' }));
  });

  it('includes emit-event when an agent declares the built-in tool', async () => {
    const agentName = uniqueId('emit-event-agent');

    const created = await createAgent({
      name: agentName,
      tools: ['emit-event'],
    });

    expect(created.statusCode).toBe(201);

    const catalog = await getCatalog();
    const emitEventTool = catalog.find((tool) => tool.name === 'emit-event');
    expect(emitEventTool).toBeDefined();
    expect(emitEventTool).toHaveProperty('source', 'local');
  });

  it('aggregates and deduplicates declared tools without guessing a source from the name', async () => {
    const sharedLocalTool = uniqueId('shared-local-tool');
    // Names that look like MCP or Composio tools are not reported as such:
    // the source comes from the provider that serves a tool (ctx-z08z).
    const mcpTool = `mcp:server:${uniqueId('search')}`;
    const composioTool = `composio.${uniqueId('gmail-send')}`;

    const createdA = await createAgent({
      name: uniqueId('providers-agent-a'),
      tools: [sharedLocalTool, mcpTool],
    });
    const createdB = await createAgent({
      name: uniqueId('providers-agent-b'),
      tools: [sharedLocalTool, composioTool],
    });

    expect(createdA.statusCode).toBe(201);
    expect(createdB.statusCode).toBe(201);

    const catalog = await getCatalog();
    const sharedMatches = catalog.filter((item) => item.name === sharedLocalTool);

    expect(sharedMatches).toHaveLength(1);
    expect(catalog).toContainEqual(expect.objectContaining({ name: sharedLocalTool, source: 'local' }));
    expect(catalog).toContainEqual(expect.objectContaining({ name: mcpTool, source: 'local' }));
    expect(catalog).toContainEqual(expect.objectContaining({ name: composioTool, source: 'local' }));
  });

  it('keeps HTTP tool definitions separate while registering them in the catalog', async () => {
    const agentName = uniqueId('http-tools-agent');
    const httpToolName = uniqueId('remote-search');

    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        ...VALID_AGENT,
        name: agentName,
        tools: [],
        httpTools: [
          {
            name: httpToolName,
            description: 'Remote search API',
            endpoint: 'https://example.com/search',
            method: 'POST',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
            },
          },
        ],
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json<{ tools: string[]; httpTools: Array<{ name: string }> }>()).toMatchObject({
      tools: [],
      httpTools: [{ name: httpToolName }],
    });

    const catalog = await getCatalog();
    const httpTool = catalog.find((item) => item.name === httpToolName);
    expect(httpTool).toBeDefined();
    expect(httpTool!.name).toBe(httpToolName);
    expect(httpTool!.source).toBe('http');
  });

  it('returns the same catalog for an empty search query', async () => {
    const withoutSearch = sortCatalog(await getCatalog('/api/catalogs/tools'));
    const withEmptySearch = sortCatalog(await getCatalog('/api/catalogs/tools?search='));

    expect(withEmptySearch).toEqual(expect.arrayContaining(withoutSearch));
  });
});
