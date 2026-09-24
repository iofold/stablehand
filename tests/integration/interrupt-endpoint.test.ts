import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

/**
 * Integration tests for POST /api/agents/:id/interrupt
 *
 * Validates the HITL interrupt endpoint: action validation,
 * approve/reject/submit resolution by independent interrupt identity,
 * and error responses (400, 404).
 */
describe('Interrupt endpoint (POST /api/agents/:id/interrupt)', () => {
  let app: TestAppHandle['app'];
  let container: TestAppHandle['container'];
  let testApp: TestAppHandle | undefined;

  beforeAll(async () => {
    testApp = await createTestApp({
      dirPrefix: 'stablehand-interrupt-',
    });
    app = testApp.app;
    container = testApp.container;
  });

  afterAll(async () => {
    await testApp?.close();
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

  async function createTurn(agentId: string, taskDescription = 'test') {
    const conv = await container.db.createConversation(agentId);
    return container.db.createTurn({
      agentId,
      conversationId: conv.id,
      mode: 'interactive',
      taskDescription,
    });
  }

  async function waitForPendingInterrupt(turnId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = await container.db.getPendingInterruptForTurn(turnId);
      if (pending) {
        return pending.id;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for pending interrupt for turn ${turnId}`);
  }

  it('valid approve action resolves the pending interrupt', async () => {
    const agentId = await createAgent('approve-test');
    const turn = await createTurn(agentId);
    const turnId = turn.id;

    const pendingPromise = app.interrupts.waitForApproval(
      turnId, agentId, 'tc-1', 'dangerousTool', { path: '/etc' }, 0,
    );
    const interruptId = await waitForPendingInterrupt(turnId);

    // POST the interrupt resolution
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', interruptId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: true, action: 'approve' });

    // The pending promise should have resolved with the approve action
    const resolution = await pendingPromise;
    expect(resolution.action).toBe('approve');
  });

  it('emits interrupt.resolved only once for an approved interrupt', async () => {
    const agentId = await createAgent('single-event-test');
    const turn = await createTurn(agentId);
    const turnId = turn.id;
    const resolvedEvents: Array<{ turnId: string; action: string }> = [];
    const onResolved = (payload: { turnId: string; action: string }) => {
      resolvedEvents.push(payload);
    };

    container.eventBus.on('interrupt.resolved', onResolved);

    try {
      const pendingPromise = app.interrupts.waitForApproval(
        turnId, agentId, 'tc-1b', 'dangerousTool', { path: '/etc' }, 0,
      );
      const interruptId = await waitForPendingInterrupt(turnId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/interrupt`,
        payload: { action: 'approve', interruptId },
      });

      expect(res.statusCode).toBe(200);
      await pendingPromise;
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0]).toMatchObject({ turnId, action: 'approve' });
    } finally {
      container.eventBus.off('interrupt.resolved', onResolved);
    }
  });

  it('valid reject action resolves the pending interrupt', async () => {
    const agentId = await createAgent('reject-test');
    const turn = await createTurn(agentId);
    const turnId = turn.id;

    const pendingPromise = app.interrupts.waitForApproval(
      turnId, agentId, 'tc-2', 'deleteTool', { id: '42' }, 0,
    );
    const interruptId = await waitForPendingInterrupt(turnId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'reject', interruptId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resolved: true, action: 'reject' });

    const resolution = await pendingPromise;
    expect(resolution.action).toBe('reject');
  });

  it('rejects legacy submit; approve carries data through', async () => {
    const agentId = await createAgent('submit-test');
    const turn = await createTurn(agentId);
    const turnId = turn.id;

    const pendingPromise = app.interrupts.waitForApproval(
      turnId, agentId, 'tc-3', 'editDocument', { docId: 'abc' }, 0,
    );
    const interruptId = await waitForPendingInterrupt(turnId);

    const submitData = { content: 'edited doc' };

    // ctx-iqzy S3 hard cut: 'submit' is no longer a resolve action.
    const legacySubmit = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'submit', interruptId, data: submitData },
    });
    expect(legacySubmit.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', interruptId, data: submitData },
    });

    expect(res.statusCode).toBe(200);
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
      payload: { action: 'cancel', interruptId: 'some-interrupt' },
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

  it('returns 404 when the interruptId does not exist', async () => {
    const agentId = await createAgent('no-pending-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', interruptId: 'nonexistent-interrupt' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/No pending interrupt/);
    expect(res.json().agentId).toBe(agentId);
  });

  it('returns 404 when a turn exists but no pending interrupt', async () => {
    const agentId = await createAgent('no-pending-test-2');
    await createTurn(agentId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', interruptId: 'nonexistent-interrupt' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/No pending interrupt/);
    expect(res.json().agentId).toBe(agentId);
  });

  it('uses interruptId as the resolve key', async () => {
    const agentId = await createAgent('interruptid-key-test');
    const turn = await createTurn(agentId);
    const turnId = turn.id;

    const pendingPromise = app.interrupts.waitForApproval(
      turnId, agentId, 'tc-4', 'tool', {}, 0,
    );
    const interruptId = await waitForPendingInterrupt(turnId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve', interruptId },
    });

    expect(res.statusCode).toBe(200);

    const resolution = await pendingPromise;
    expect(resolution.action).toBe('approve');
  });

  it('requires interruptId when it is omitted from the interrupt payload', async () => {
    const agentId = await createAgent('fallback-key-test');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/interrupt`,
      payload: { action: 'approve' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/interruptId is required/);
  });
});
