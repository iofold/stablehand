import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';

describe('CTXMill Server Integration (ORC-01, ORC-02, ORC-18)', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));

    container = await createContainer(
      {
        preset: 'local',
        database: {
          type: 'sqlite',
          path: 'data.db',
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
      executor: container.agentExecutor,
      agents: new Map(),
    });

    // Use inject() — no listen() call needed
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── ORC-01: Health check ────────────────────────────────

  it('GET /health returns { status: "ok" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  // ── ORC-02: Agent list (empty) ──────────────────────────

  it('GET /api/agents returns empty array when no agents exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  // ── ORC-02: Catalog schema ──────────────────────────────

  it('GET /api/catalogs returns the A2UI catalog schema', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/catalogs' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.catalogs).toBeDefined();
    expect(Array.isArray(body.catalogs)).toBe(true);
    expect(body.catalogs.length).toBeGreaterThan(0);

    // Verify known catalog entries
    const chartCatalog = body.catalogs.find(
      (c: { name: string }) => c.name === 'ctxmill.charts',
    );
    expect(chartCatalog).toBeDefined();
    expect(chartCatalog.components.TimeSeriesChart).toBeDefined();

    const hitlCatalog = body.catalogs.find(
      (c: { name: string }) => c.name === 'ctxmill.hitl',
    );
    expect(hitlCatalog).toBeDefined();
    expect(hitlCatalog.components.ApprovalCard).toBeDefined();
  });

  // ── ORC-18: Agent CRUD via HTTP ─────────────────────────

  it('GET /api/agents/:id returns agent after creation via DB', async () => {
    const agent = await container.db.createAgent({
      name: 'Integration Test Agent',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a test agent.',
      tools: ['bash'],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.id}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(agent.id);
    expect(body.name).toBe('Integration Test Agent');
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.conversationCount).toBe(0);
    expect(body.sseClients).toBe(0);
    expect(body.hasPendingInterrupt).toBe(false);
  });

  it('GET /api/agents/:id returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/does-not-exist',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe('Agent not found');
  });

  it('GET /api/agents lists agents after creation', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((a: { name: string }) => a.name === 'Integration Test Agent')).toBe(true);
  });

  // ── ORC-02: SSE stream endpoint ─────────────────────────

  it('GET /api/agents/:id/stream returns SSE content-type', async () => {
    // Ensure the agent exists
    const agents = await container.db.listAgents();
    const agent = agents[0];
    expect(agent).toBeDefined();

    // The SSE route writes to reply.raw and never closes the connection,
    // so a normal inject() call would hang. We listen on an ephemeral port,
    // make a real HTTP request, inspect the headers, then abort.
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const controller = new AbortController();
      const res = await fetch(`${address}/api/agents/${agent.id}/stream`, {
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // Read the first chunk to verify initial CONNECTED event
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('CONNECTED');

      // Abort the stream — we have what we need
      controller.abort();
      reader.releaseLock();
    } finally {
      await app.close();
      // Re-create the server for remaining tests and afterAll cleanup
      app = await createServer({
        db: container.db,
        executor: container.agentExecutor,
        agents: new Map(),
      });
      await app.ready();
    }
  });

  it('GET /api/agents/:id/stream returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/no-such-agent/stream',
    });

    expect(res.statusCode).toBe(404);
  });
});
