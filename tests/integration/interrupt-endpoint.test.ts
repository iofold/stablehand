import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  let app: Awaited<ReturnType<typeof createServer>>;
  let container: AppContainer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-interrupt-'));

    container = await createContainer(
      {
        preset: 'docker',
        database: { url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
      },
      dataDir,
    );

    app = await createServer({
      db: container.db,
      agentSessionService: container.agentSessionService,
      eventBus: container.eventBus,
      interrupts: container.interruptManager,
      sessionManager: container.sessionManager,
      runStartupService: container.runStartupService,
      dataDir,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await container.close();
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
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'Interrupt test agent',
        tools: [],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  async function createSession(agentId: string, taskDescription = 'test') {
    const conv = await container.db.createConversation(agentId);
    return container.db.createTurn({
      agentId,
      conversationId: conv.id,
      mode: 'interactive',
      taskDescription,
    });
  }

  async function waitForPendingInterrupt(sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = await container.db.getPendingInterrupt(sessionId);
      if (pending) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for pending interrupt ${sessionId}`);
  }

  it('valid approve action resolves the pending interrupt', async () => {
    const agentId = await createAgent('approve-test');
    const session = await createSession(agentId);
    const sessionId = session.id;

    const pendingPromise = app.interrupts.waitForApproval(
      sessionId, agentId, 'tc-1', 'dangerousTool', { path: '/etc' }, 0,
    );
    await waitForPendingInterrupt(sessionId);

    // POST the interrupt resolution
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', sessionId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: true, action: 'approve' });

    // The pending promise should have resolved with the approve action
    const resolution = await pendingPromise;
    expect(resolution.action).toBe('approve');
  });

  it('emits run.interrupt_resolved only once for an approved interrupt', async () => {
    const agentId = await createAgent('single-event-test');
    const session = await createSession(agentId);
    const sessionId = session.id;
    const resolvedEvents: Array<{ turnId: string; action: string }> = [];
    const onResolved = (payload: { turnId: string; action: string }) => {
      resolvedEvents.push(payload);
    };

    container.eventBus.on('run.interrupt_resolved', onResolved);

    try {
      const pendingPromise = app.interrupts.waitForApproval(
        sessionId, agentId, 'tc-1b', 'dangerousTool', { path: '/etc' }, 0,
      );
      await waitForPendingInterrupt(sessionId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/interrupt`,
        payload: { action: 'approve', sessionId },
      });

      expect(res.statusCode).toBe(200);
      await pendingPromise;
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0]).toMatchObject({ turnId: sessionId, action: 'approve' });
    } finally {
      container.eventBus.off('run.interrupt_resolved', onResolved);
    }
  });

  it('valid reject action resolves the pending interrupt', async () => {
    const agentId = await createAgent('reject-test');
    const session = await createSession(agentId);
    const sessionId = session.id;

    const pendingPromise = app.interrupts.waitForApproval(
      sessionId, agentId, 'tc-2', 'deleteTool', { id: '42' }, 0,
    );
    await waitForPendingInterrupt(sessionId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'reject', sessionId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: true, action: 'reject' });

    const resolution = await pendingPromise;
    expect(resolution.action).toBe('reject');
  });

  it('submit action maps to approve with data passed through', async () => {
    const agentId = await createAgent('submit-test');
    const session = await createSession(agentId);
    const sessionId = session.id;

    const pendingPromise = app.interrupts.waitForApproval(
      sessionId, agentId, 'tc-3', 'editDocument', { docId: 'abc' }, 0,
    );
    await waitForPendingInterrupt(sessionId);

    const submitData = { content: 'edited doc' };

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'submit', sessionId, data: submitData },
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
      payload: { action: 'cancel', sessionId: 'some-session' },
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

  it('returns 404 when no pending interrupt exists for sessionId', async () => {
    const agentId = await createAgent('no-pending-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', sessionId: 'nonexistent-session' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/No pending interrupt/);
    expect(res.json().agentId).toBe(agentId);
  });

  it('returns 404 when session exists but no pending interrupt', async () => {
    const agentId = await createAgent('no-pending-test-2');
    const session = await createSession(agentId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', sessionId: session.id },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/No pending interrupt/);
    expect(res.json().agentId).toBe(agentId);
  });

  it('uses sessionId as resolve key when provided', async () => {
    const agentId = await createAgent('sessionid-key-test');
    const session = await createSession(agentId);
    const sessionId = session.id;

    const pendingPromise = app.interrupts.waitForApproval(
      sessionId, agentId, 'tc-4', 'tool', {}, 0,
    );
    await waitForPendingInterrupt(sessionId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', sessionId },
    });

    expect(res.statusCode).toBe(200);

    const resolution = await pendingPromise;
    expect(resolution.action).toBe('approve');
  });

  it('requires sessionId when it is omitted from the interrupt payload', async () => {
    const agentId = await createAgent('fallback-key-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/sessionId is required/);
  });
});
