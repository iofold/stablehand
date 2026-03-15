import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';
import { MockOverlayFactory } from '../../packages/ctxmill/src/workspace/mock-overlay.js';

const VALID_AGENT = {
  name: 'test-agent',
  model: 'test-model',
  systemPrompt: 'You are a test agent.',
  tools: ['tool-a', 'tool-b'],
};

describe('Agent CRUD & related endpoints', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-agent-crud-'));

    container = await createContainer(
      {
        preset: 'local',
        database: { type: 'sqlite', path: 'data.db' },
        llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test-key-not-used' },
      },
      dataDir,
    );

    const envFactory = new MockOverlayFactory();

    app = await createServer({
      db: container.db,
      executor: container.agentExecutor,
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { ...VALID_AGENT, ...overrides },
    });
    return res;
  }

  // ── POST /api/agents ───────────────────────────────────────

  describe('POST /api/agents', () => {
    it('creates agent with valid payload', async () => {
      const res = await createAgent({ name: 'create-valid' });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe('create-valid');
      expect(body.model).toBe(VALID_AGENT.model);
      expect(body.tools).toEqual(VALID_AGENT.tools);
    });

    it('rejects missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { model: 'x', systemPrompt: 'x', tools: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing model', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'x', systemPrompt: 'x', tools: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing systemPrompt', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'x', model: 'x', tools: [] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing tools', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'x', model: 'x', systemPrompt: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-array tools', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'x', model: 'x', systemPrompt: 'x', tools: 'not-array' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── PUT /api/agents/:id ────────────────────────────────────

  describe('PUT /api/agents/:id', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'update-target' });
      agentId = res.json().id;
    });

    it('updates name only', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}`,
        payload: { name: 'renamed-agent' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('renamed-agent');
    });

    it('updates model only', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}`,
        payload: { model: 'new-model' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().model).toBe('new-model');
    });

    it('updates multiple fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}`,
        payload: { name: 'multi-update', systemPrompt: 'updated prompt', tools: ['new-tool'] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('multi-update');
      expect(body.systemPrompt).toBe('updated prompt');
      expect(body.tools).toEqual(['new-tool']);
    });

    it('rejects update with no fields', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/agents/${agentId}`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects update on non-existent agent', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/agents/nonexistent-id',
        payload: { name: 'nope' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── DELETE /api/agents/:id ─────────────────────────────────

  describe('DELETE /api/agents/:id', () => {
    it('deletes existing agent and GET returns 404', async () => {
      const created = await createAgent({ name: 'delete-me' });
      const id = created.json().id;

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/agents/${id}`,
      });
      expect(delRes.statusCode).toBe(204);

      const getRes = await app.inject({
        method: 'GET',
        url: `/api/agents/${id}`,
      });
      expect(getRes.statusCode).toBe(404);
    });

    it('returns 404 for non-existent agent', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/agents/nonexistent-id',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── GET /api/agents/:id/conversations ──────────────────────

  describe('GET /api/agents/:id/conversations', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'conv-agent' });
      agentId = res.json().id;
    });

    it('returns empty array initially', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/conversations`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('lists conversations after creating one', async () => {
      await container.db.createConversation(agentId);

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/conversations`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.length).toBe(1);
      expect(body[0].agentId).toBe(agentId);
    });
  });

  // ── GET /api/agents/:id/runs ───────────────────────────────

  describe('GET /api/agents/:id/runs', () => {
    let agentId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'runs-agent' });
      agentId = res.json().id;
    });

    it('returns empty for fresh agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/runs`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('lists runs after creating one', async () => {
      const conv = await container.db.createConversation(agentId);
      const run = await container.runRegistry.startRun(agentId, conv.id, 'background', 'test');

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/runs`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some((r: any) => r.id === run.id)).toBe(true);

      await container.runRegistry.completeRun(run.id);
    });
  });

  // ── GET /api/agents/:id/runs/:runId ────────────────────────

  describe('GET /api/agents/:id/runs/:runId', () => {
    let agentId: string;
    let runId: string;

    beforeAll(async () => {
      const res = await createAgent({ name: 'run-detail-agent' });
      agentId = res.json().id;
      const conv = await container.db.createConversation(agentId);
      const run = await container.runRegistry.startRun(agentId, conv.id, 'background', 'detail test');
      runId = run.id;
    });

    it('returns run with messages array', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/runs/${runId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.run).toBeDefined();
      expect(body.run.id).toBe(runId);
      expect(Array.isArray(body.messages)).toBe(true);
    });

    it('returns 404 for non-existent runId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/runs/nonexistent-run`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── POST /api/agents/:id/runs/:runId/cancel ────────────────

  describe('POST /api/agents/:id/runs/:runId/cancel', () => {
    it('cancels existing run', async () => {
      const created = await createAgent({ name: 'cancel-agent' });
      const agentId = created.json().id;
      const conv = await container.db.createConversation(agentId);
      const run = await container.runRegistry.startRun(agentId, conv.id, 'background', 'cancel me');

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/runs/${run.id}/cancel`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().cancelled).toBe(true);
    });
  });

  // ── GET /api/runs ──────────────────────────────────────────

  describe('GET /api/runs', () => {
    it('returns active runs list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/runs',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });

  // ── GET /api/agents/:id/versions ───────────────────────────

  describe('GET /api/agents/:id/versions', () => {
    it('returns versions array', async () => {
      const created = await createAgent({ name: 'version-agent' });
      const agentId = created.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/api/agents/${agentId}/versions`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.versions).toBeDefined();
      expect(Array.isArray(body.versions)).toBe(true);
    });
  });

  // ── GET /api/config ────────────────────────────────────────

  describe('GET /api/config', () => {
    it('returns config with llm, system, agentDefaults sections', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/config',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.llm).toBeDefined();
      expect(body.system).toBeDefined();
      expect(body.agentDefaults).toBeDefined();
    });
  });

  // ── GET /api/catalogs/tools ────────────────────────────────

  describe('GET /api/catalogs/tools', () => {
    it('returns tool catalog array', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/catalogs/tools',
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });
  });
});
