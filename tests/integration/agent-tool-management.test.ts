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

describe('Agent tool management integration', () => {
  let app: TestAppHandle['app'];
  let testApp: TestAppHandle | undefined;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'ctxmill-agent-tool-management-',
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

  async function updateAgent(agentId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: `/api/agents/${agentId}`,
      payload,
    });
  }

  async function getAgent(agentId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}`,
    });
  }

  describe('tool add/remove/update behavior', () => {
    it('creates an agent with tools and GET returns the same tools', async () => {
      const createRes = await createAgent({
        name: 'tool-create-get',
        tools: ['search-web', 'fetch-doc'],
      });

      expect(createRes.statusCode).toBe(201);
      const agentId = createRes.json().id;

      const getRes = await getAgent(agentId);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tools).toEqual(['search-web', 'fetch-doc']);
    });

    it('updates an agent to remove a tool and GET reflects the removal', async () => {
      const createRes = await createAgent({
        name: 'tool-remove',
        tools: ['alpha-tool', 'beta-tool'],
      });
      const agentId = createRes.json().id;

      const updateRes = await updateAgent(agentId, { tools: ['alpha-tool'] });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().tools).toEqual(['alpha-tool']);

      const getRes = await getAgent(agentId);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tools).toEqual(['alpha-tool']);
    });

    it('updates an agent to add a tool and GET reflects the addition', async () => {
      const createRes = await createAgent({
        name: 'tool-add',
        tools: ['alpha-tool'],
      });
      const agentId = createRes.json().id;

      const updateRes = await updateAgent(agentId, { tools: ['alpha-tool', 'beta-tool'] });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().tools).toEqual(['alpha-tool', 'beta-tool']);

      const getRes = await getAgent(agentId);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tools).toEqual(['alpha-tool', 'beta-tool']);
    });

    it('updates an agent with an empty tools array so no declared tools remain', async () => {
      const createRes = await createAgent({
        name: 'tool-empty-array',
        tools: ['alpha-tool', 'beta-tool'],
      });
      const agentId = createRes.json().id;

      const updateRes = await updateAgent(agentId, { tools: [] });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().tools).toEqual([]);

      const getRes = await getAgent(agentId);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tools).toEqual([]);
    });

    it('stores a non-existent tool name without catalog validation', async () => {
      const createRes = await createAgent({
        name: 'tool-non-existent',
        tools: ['imaginary-tool-name'],
      });

      expect(createRes.statusCode).toBe(201);
      const agentId = createRes.json().id;

      const getRes = await getAgent(agentId);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().tools).toEqual(['imaginary-tool-name']);
    });
  });

  describe('nativeTools contract behavior', () => {
    it('saves nativeTools allowlist and GET returns it', async () => {
      const createRes = await createAgent({
        name: 'native-tools-allowlist',
        nativeTools: {
          allowlist: ['Bash', 'Read', 'Write'],
        },
      });

      expect(createRes.statusCode).toBe(201);
      const agentId = createRes.json().id;

      const getRes = await getAgent(agentId);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().nativeTools).toEqual({
        allowlist: ['Bash', 'Read', 'Write'],
      });
    });

    it('clears nativeTools when updated back to default metadata', async () => {
      const createRes = await createAgent({
        name: 'native-tools-clear',
        nativeTools: {
          allowlist: ['Bash'],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const agentId = createRes.json().id;

      const updateRes = await updateAgent(agentId, { nativeTools: null });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().nativeTools).toBeNull();

      const getRes = await getAgent(agentId);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().nativeTools).toBeNull();
    });
  });

  describe('GET /api/catalogs/tools', () => {
    it('returns tools aggregated from local, mcp-style, and http-tool providers', async () => {
      const localAgentRes = await createAgent({
        name: 'catalog-local-tools',
        tools: ['local-tool'],
      });
      expect(localAgentRes.statusCode).toBe(201);

      const mcpAndHttpAgentRes = await createAgent({
        name: 'catalog-remote-tools',
        tools: ['remote:lookup'],
        httpTools: [
          {
            name: 'http-ingest',
            description: 'HTTP ingest endpoint',
            endpoint: 'https://example.com/ingest',
            method: 'POST',
          },
        ],
      });
      expect(mcpAndHttpAgentRes.statusCode).toBe(201);

      const catalogRes = await app.inject({
        method: 'GET',
        url: '/api/catalogs/tools',
      });

      expect(catalogRes.statusCode).toBe(200);
      const catalog = catalogRes.json();

      expect(catalog).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'local-tool', source: 'local' }),
        expect.objectContaining({ name: 'remote:lookup', source: 'mcp' }),
        expect.objectContaining({ name: 'http-ingest', source: 'local' }),
      ]));
    });
  });
});
