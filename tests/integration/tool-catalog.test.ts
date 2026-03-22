import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

const VALID_AGENT = {
  name: 'test-agent',
  harness: 'langgraph',
  harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
  systemPrompt: 'You are a test agent.',
  tools: ['tool-a', 'tool-b'],
};

interface CatalogTool {
  name: string;
  description?: string;
  source: 'local' | 'mcp' | 'composio';
  inputSchema?: Record<string, unknown>;
}

interface TestApp {
  inject: (opts: { method: string; url: string; payload?: unknown }) => Promise<{
    statusCode: number;
    json: <T = unknown>() => T;
  }>;
  ready: () => PromiseLike<unknown>;
  close: () => Promise<void>;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortCatalog(tools: CatalogTool[]): CatalogTool[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

describe('GET /api/catalogs/tools', () => {
  let app: TestApp;
  let container: AppContainer;
  let dataDir: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-tool-catalog-'));

    container = await createContainer(
      {
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
      dataDir,
      envFactory,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
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

  it('aggregates and deduplicates tools from multiple provider-style names', async () => {
    const sharedLocalTool = uniqueId('shared-local-tool');
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
    expect(catalog).toContainEqual(expect.objectContaining({ name: mcpTool, source: 'mcp' }));
    expect(catalog).toContainEqual(expect.objectContaining({ name: composioTool, source: 'composio' }));
  });

  it('includes HTTP tool names after creating an agent with httpTools', async () => {
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
    expect(created.json<{ tools: string[] }>().tools).toContain(httpToolName);

    const catalog = await getCatalog();
    const httpTool = catalog.find((item) => item.name === httpToolName);
    expect(httpTool).toBeDefined();
    expect(httpTool!.name).toBe(httpToolName);
    expect(httpTool!.source).toBe('local');
  });

  it('returns the same catalog for an empty search query', async () => {
    const withoutSearch = sortCatalog(await getCatalog('/api/catalogs/tools'));
    const withEmptySearch = sortCatalog(await getCatalog('/api/catalogs/tools?search='));

    expect(withEmptySearch).toEqual(withoutSearch);
  });
});
