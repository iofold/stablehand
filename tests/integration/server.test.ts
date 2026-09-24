import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

describe('Stablehand Server Integration (ORC-01, ORC-02)', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;

  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'stablehand-test-',
    });
    app = testApp.app;
    container = testApp.container;
  });

  afterAll(async () => {
    await testApp?.close();
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

  it('GET /api/agents returns an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  // ── ORC-02: Agent CRUD via HTTP ─────────────────────────

  it('GET /api/agents/:id returns agent after creation via DB', async () => {
    const agent = await container.db.createAgent({
      name: 'Integration Test Agent',
      harness: 'claude-agents',
      harnessConfig: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
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
    expect(body.harness).toBe('claude-agents');
    expect((body.harnessConfig as Record<string, unknown>).model).toBe('claude-sonnet-4-6');
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
      app = await testApp.restart();
    }
  });

  it('GET /api/agents/:id/stream bootstraps active turn identity in state snapshots', async () => {
    const agent = await container.db.createAgent({
      name: 'Streaming Snapshot Agent',
      harness: 'langgraph',
      harnessConfig: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini' }),
      systemPrompt: 'You are a test agent.',
      tools: [],
    });
    const turnId = `turn-stream-test-${Date.now()}`;
    const conversation = await container.db.createConversation(agent.id);
    const sandboxSession = await container.db.createSandboxSession({
      conversationId: conversation.id,
      agentId: agent.id,
      containerName: 'stablehand-sandbox-stream-test',
      containerId: 'container-stream-test',
      harnessName: 'langgraph',
      status: 'ACTIVE',
    });
    await container.db.createTurn({
      id: turnId,
      agentId: agent.id,
      conversationId: conversation.id,
      sandboxSessionId: sandboxSession.id,
      mode: 'interactive',
    });

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const controller = new AbortController();
      const res = await fetch(`${address}/api/agents/${agent.id}/stream`, {
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      let text = '';

      while (!text.includes('stablehand.sandbox_session.snapshot')) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for state snapshot')), 2_000)),
        ]);

        if (done) {
          break;
        }

        text += new TextDecoder().decode(value);
      }

      expect(text).toContain('"type":"CUSTOM"');
      expect(text).toContain('"name":"stablehand.sandbox_session.snapshot"');
      expect(text).not.toContain('"subtype":"state_snapshot"');
      expect(text).toContain(`"agentId":"${agent.id}"`);
      expect(text).toContain(`"conversationId":"${conversation.id}"`);
      expect(text).toContain(`"sandboxSessionId":"${sandboxSession.id}"`);
      expect(text).toContain(`"activeTurnId":"${turnId}"`);
      expect(text).toContain('"status":"ACTIVE"');
      expect(text).toContain('"harnessName":"langgraph"');
      expect(text).toContain('"containerName":"stablehand-sandbox-stream-test"');
      expect(text).toMatch(/"timestamp":\d+/);

      controller.abort();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } finally {
      app = await testApp.restart();
    }
  }, 15_000);

  it('GET /api/agents/:id/stream returns 404 for non-existent agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/no-such-agent/stream',
    });

    expect(res.statusCode).toBe(404);
  });

  it('container creates all services with interface types', async () => {
    expect(container.toolExecutor).toBeDefined();
    expect(container.agentTurnService).toBeDefined();
    expect(container.eventBus).toBeDefined();
    expect(container.sseManager).toBeDefined();
    expect(container.interruptManager).toBeDefined();
    expect(container.sessionManager).toBeDefined();
  });
});
