import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';
import { allowConsoleErrors } from '../setup-strict.js';

type HttpToolDefinition = {
  name?: string;
  description?: string;
  endpoint?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  inputSchema?: Record<string, unknown>;
};

describe('HTTP tool CRUD via agent API', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;

  const validAgent = {
    name: 'http-tool-agent',
    harness: 'langgraph',
    harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
    systemPrompt: 'You are a helpful agent.',
    tools: ['base-tool'],
    description: 'Agent used for HTTP tool CRUD tests',
  };

  function buildHttpTool(overrides: HttpToolDefinition = {}) {
    return {
      name: 'search-api',
      description: 'Search an external API',
      endpoint: 'https://api.example.com/search',
      method: 'POST' as const,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      ...overrides,
    };
  }

  async function createAgent(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        ...validAgent,
        ...overrides,
      },
    });
  }

  beforeEach(() => {
    allowConsoleErrors();
  });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-http-tool-crud-'));

    container = await createContainer(
      {
        preset: 'local',
        database: {
          url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill',
        },
        llm: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          apiKey: 'test-key-not-used',
        },
      },
      dataDir,
    );

    app = await createServer({
      db: container.db,
      agentRunService: container.agentRunService,
      runRegistry: container.runRegistry,
      eventBus: container.eventBus,
      dataDir,
      envFactory: new MockOverlayFactory(),
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('POST /api/agents with httpTools includes HTTP tool names in tools', async () => {
    const response = await createAgent({
      name: 'create-http-tools',
      tools: ['base-tool'],
      httpTools: [buildHttpTool()],
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();

    expect(body.tools).toEqual(['base-tool', 'search-api']);
    expect(body.metadata.httpTools).toEqual([buildHttpTool()]);
  });

  it('PUT /api/agents/:id updates httpTools and removes old HTTP tools', async () => {
    const created = await createAgent({
      name: 'replace-http-tools',
      tools: ['base-tool'],
      httpTools: [buildHttpTool({ name: 'old-http-tool' })],
    });
    const agentId = created.json().id;

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agentId}`,
      payload: {
        httpTools: [
          buildHttpTool({
            name: 'weather-api',
            description: 'Fetch weather data',
            endpoint: 'https://api.example.com/weather',
            method: 'GET',
          }),
        ],
      },
    });

    expect(updateResponse.statusCode).toBe(200);

    const body = updateResponse.json();

    expect(body.tools).toEqual(['base-tool', 'weather-api']);
    expect(body.tools).not.toContain('old-http-tool');
    expect(body.metadata.httpTools).toEqual([
      buildHttpTool({
        name: 'weather-api',
        description: 'Fetch weather data',
        endpoint: 'https://api.example.com/weather',
        method: 'GET',
      }),
    ]);
  });

  it('GET /api/agents/:id returns metadata.httpTools', async () => {
    const created = await createAgent({
      name: 'get-http-tools',
      httpTools: [buildHttpTool()],
    });
    const agentId = created.json().id;

    const response = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}`,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.metadata.httpTools).toEqual([buildHttpTool()]);
    expect(body.tools).toContain('search-api');
  });

  it('creates an agent with mixed base tools and httpTools merged together', async () => {
    const response = await createAgent({
      name: 'mixed-tools',
      tools: ['file-read', 'web-search'],
      httpTools: [
        buildHttpTool({ name: 'search-api' }),
        buildHttpTool({
          name: 'weather-api',
          description: 'Fetch weather data',
          endpoint: 'https://api.example.com/weather',
          method: 'GET',
        }),
      ],
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();

    expect(body.tools).toEqual(['file-read', 'web-search', 'search-api', 'weather-api']);
    expect(body.metadata.httpTools).toHaveLength(2);
  });

  it('updating only httpTools preserves base tools', async () => {
    const created = await createAgent({
      name: 'preserve-base-tools',
      tools: ['file-read', 'web-search'],
      httpTools: [buildHttpTool({ name: 'old-http-tool' })],
    });
    const agentId = created.json().id;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agentId}`,
      payload: {
        httpTools: [buildHttpTool({ name: 'replacement-http-tool' })],
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.tools).toEqual(['file-read', 'web-search', 'replacement-http-tool']);
    expect(body.metadata.httpTools).toEqual([buildHttpTool({ name: 'replacement-http-tool' })]);
  });

  it('updating only base tools preserves httpTools', async () => {
    const created = await createAgent({
      name: 'preserve-http-tools',
      tools: ['file-read'],
      httpTools: [buildHttpTool({ name: 'search-api' })],
    });
    const agentId = created.json().id;

    const response = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agentId}`,
      payload: {
        tools: ['web-search', 'calculator'],
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.tools).toEqual(['web-search', 'calculator', 'search-api']);
    expect(body.metadata.httpTools).toEqual([buildHttpTool({ name: 'search-api' })]);
  });

  it('rejects httpTool with missing name', async () => {
    const response = await createAgent({
      name: 'missing-http-tool-name',
      httpTools: [buildHttpTool({ name: undefined })],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('HTTP tool requires name, description, and endpoint');
  });

  it('rejects httpTool with missing description', async () => {
    const response = await createAgent({
      name: 'missing-http-tool-description',
      httpTools: [buildHttpTool({ description: undefined })],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('HTTP tool requires name, description, and endpoint');
  });

  it('rejects httpTool with missing endpoint', async () => {
    const response = await createAgent({
      name: 'missing-http-tool-endpoint',
      httpTools: [buildHttpTool({ endpoint: undefined })],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('HTTP tool requires name, description, and endpoint');
  });

  it('DELETE /api/agents/:id cleans up the agent and its HTTP tools', async () => {
    const created = await createAgent({
      name: 'delete-http-tool-agent',
      httpTools: [buildHttpTool()],
    });
    const agentId = created.json().id;

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}`,
    });

    expect(deleteResponse.statusCode).toBe(204);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}`,
    });

    expect(getResponse.statusCode).toBe(404);
  });
});
