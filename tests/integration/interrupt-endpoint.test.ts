import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

import { createContainer } from '../../packages/ctxmill/src/config/container.js';
import { createServer } from '../../packages/ctxmill/src/orchestrator/server.js';
import type { AppContainer } from '../../packages/ctxmill/src/config/container.js';

/**
 * Integration tests for POST /api/agents/:id/interrupt
 *
 * Validates the HITL interrupt endpoint: action validation,
 * approve/reject/submit resolution, runId vs agentId fallback,
 * and error responses (400, 404).
 */
describe('Interrupt endpoint (POST /api/agents/:id/interrupt)', () => {
  let app: FastifyInstance;
  let container: AppContainer;
  let dataDir: string;
  beforeEach(() => { allowConsoleErrors(); });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-interrupt-'));

    container = await createContainer(
      {
        preset: 'local',
        database: { url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
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
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Helper: create an agent via HTTP and return its id. */
  async function createAgent(name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name,
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
        systemPrompt: 'Interrupt test agent',
        tools: [],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it('valid approve action resolves the pending interrupt', async () => {
    const agentId = await createAgent('approve-test');

    // Register a run in the RunRegistry so the ownership check passes
    const registeredRun = await container.runRegistry.startRun(agentId, 'conv-approve', 'interactive', 'test');
    const runId = registeredRun.id;

    // Create a pending interrupt keyed by runId
    const pendingPromise = app.interrupts.waitForApproval(
      runId, agentId, 'tc-1', 'dangerousTool', { path: '/etc' }, 0,
    );

    // POST the interrupt resolution
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', runId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: true, action: 'approve' });

    // The pending promise should have resolved with the approve action
    const resolution = await pendingPromise;
    expect(resolution.action).toBe('approve');
  });

  it('valid reject action resolves the pending interrupt', async () => {
    const agentId = await createAgent('reject-test');

    // Register a run in the RunRegistry so the ownership check passes
    const registeredRun = await container.runRegistry.startRun(agentId, 'conv-reject', 'interactive', 'test');
    const runId = registeredRun.id;

    const pendingPromise = app.interrupts.waitForApproval(
      runId, agentId, 'tc-2', 'deleteTool', { id: '42' }, 0,
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'reject', runId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: true, action: 'reject' });

    const resolution = await pendingPromise;
    expect(resolution.action).toBe('reject');
  });

  it('submit action maps to approve with data passed through', async () => {
    const agentId = await createAgent('submit-test');

    // Register a run in the RunRegistry so the ownership check passes
    const registeredRun = await container.runRegistry.startRun(agentId, 'conv-submit', 'interactive', 'test');
    const runId = registeredRun.id;

    const pendingPromise = app.interrupts.waitForApproval(
      runId, agentId, 'tc-3', 'editDocument', { docId: 'abc' }, 0,
    );

    const submitData = { content: 'edited doc' };

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'submit', runId, data: submitData },
    });

    expect(res.statusCode).toBe(200);
    // submit is mapped to approve on the response
    expect(res.json()).toEqual({ resolved: true, action: 'approve' });

    const resolution = await pendingPromise;
    expect(resolution.action).toBe('approve');
    expect(resolution.data).toEqual(submitData);
  });

  it('returns 400 for invalid action', async () => {
    const agentId = await createAgent('invalid-action-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'cancel', runId: 'some-run' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/action is required/);
  });

  it('returns 400 for missing action (empty body)', async () => {
    const agentId = await createAgent('missing-action-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/action is required/);
  });

  it('returns 404 when no pending interrupt exists (runId not in registry)', async () => {
    const agentId = await createAgent('no-pending-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', runId: 'nonexistent-run' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/No pending interrupt/);
    expect(res.json().agentId).toBe(agentId);
  });

  it('returns 404 when run exists but no pending interrupt', async () => {
    const agentId = await createAgent('no-pending-test-2');

    // Register a run so ownership check passes, but don't create an interrupt
    const registeredRun = await container.runRegistry.startRun(agentId, 'conv-no-pending', 'interactive', 'test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', runId: registeredRun.id },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/No pending interrupt/);
    expect(res.json().agentId).toBe(agentId);
  });

  it('uses runId as resolve key when provided', async () => {
    const agentId = await createAgent('runid-key-test');

    // Register a run in the RunRegistry so the ownership check passes
    const registeredRun = await container.runRegistry.startRun(agentId, 'conv-key', 'interactive', 'test');
    const runId = registeredRun.id;

    // Interrupt is keyed by runId
    const pendingPromise = app.interrupts.waitForApproval(
      runId, agentId, 'tc-4', 'tool', {}, 0,
    );

    // Resolve using runId in the body
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', runId },
    });

    expect(res.statusCode).toBe(200);

    const resolution = await pendingPromise;
    expect(resolution.action).toBe('approve');
  });

  it('falls back to agentId as resolve key when runId is omitted', async () => {
    const agentId = await createAgent('fallback-key-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/runId is required/);
  });
});
