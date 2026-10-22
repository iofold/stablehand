import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestApp, type TestAppHandle } from '../utils/test-app.js';
import { createTestDb } from '../utils/test-db.js';

/**
 * ctx-v6ef: a trigger whose target refuses the run must not block the event
 * spine. The firing is dead-lettered (trigger_firings status 'failed'),
 * announced with a trigger.failed event, listed by GET /api/triggers/failures,
 * and the event-triggers cursor moves past the event.
 */
describe('trigger dead letters', () => {
  let testApp: TestAppHandle | undefined;

  async function resetDatabase(): Promise<void> {
    const reset = await createTestDb();
    await reset.close();
  }

  beforeAll(async () => {
    await resetDatabase();
    testApp = await createTestApp({ dirPrefix: 'stablehand-trigger-dead-letters-' });
  });

  afterAll(async () => {
    try {
      await testApp?.close();
    } finally {
      await resetDatabase();
    }
  });

  async function createAgent(name: string, mode: 'interactive' | 'background'): Promise<string> {
    if (!testApp) throw new Error('test app did not start');
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name,
        harness: 'langgraph',
        harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
        systemPrompt: 'You are a test agent.',
        tools: [],
        mode,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function createTrigger(agentId: string, eventType: string): Promise<string> {
    if (!testApp) throw new Error('test app did not start');
    const res = await testApp.app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: { agentId, eventType, taskTemplate: 'Handle {{payload.n}}', enabled: true },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function emit(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!testApp) throw new Error('test app did not start');
    const res = await testApp.app.inject({ method: 'POST', url: '/api/triggers/emit', payload: { type, payload } });
    expect(res.statusCode).toBe(200);
  }

  it('dead-letters a run the target refuses, surfaces it, and keeps the spine moving', async () => {
    if (!testApp) throw new Error('test app did not start');
    const { app, container } = testApp;
    const launches = vi.spyOn(container.turnStartupService, 'launchPreparedTurn').mockResolvedValue(undefined);
    try {
      const chatOnly = await createAgent('chat-only-target', 'interactive');
      const worker = await createAgent('background-target', 'background');
      const refusedTrigger = await createTrigger(chatOnly, 'custom.v6ef.poison');
      const acceptedTrigger = await createTrigger(worker, 'custom.v6ef.next');

      await emit('custom.v6ef.poison', { n: 1 });
      await emit('custom.v6ef.next', { n: 2 });

      let failures: Array<Record<string, unknown>> = [];
      await vi.waitFor(async () => {
        const res = await app.inject({ method: 'GET', url: `/api/triggers/failures?triggerId=${refusedTrigger}` });
        expect(res.statusCode).toBe(200);
        failures = (res.json() as { failures: Array<Record<string, unknown>> }).failures;
        expect(failures).toHaveLength(1);
      }, { timeout: 10_000, interval: 50 });
      expect(failures[0]).toMatchObject({
        triggerId: refusedTrigger,
        agentId: chatOnly,
        eventType: 'custom.v6ef.poison',
        errorCode: 'agent_mode_not_allowed',
        error: 'Agent mode "interactive" does not allow background turns',
        attempts: 1,
      });
      const poisonSeq = Number(failures[0]?.eventSeq);

      // The next event's trigger still fires.
      await vi.waitFor(() => expect(launches).toHaveBeenCalledWith(
        expect.objectContaining({ taskDescription: 'Handle 2', mode: 'background' }),
        worker,
        expect.any(Object),
      ), { timeout: 10_000, interval: 50 });

      // Ordered catch-up settles the refused firing instead of retrying it forever.
      await container.spineConsumerRunner.catchUpAll();
      const nextEvents = await app.inject({ method: 'GET', url: '/api/events?type=custom.v6ef.next' });
      const nextSeq = Number((nextEvents.json() as { events: Array<{ seq: number }> }).events[0]?.seq);
      expect(await container.db.getSpineCursor('event-triggers')).toBeGreaterThanOrEqual(Math.max(poisonSeq, nextSeq));
      expect(await container.db.hasTriggerFiring(acceptedTrigger, nextSeq)).toBe(true);

      // Notice on the event log, nothing queued for the refusing agent.
      const notices = await app.inject({ method: 'GET', url: '/api/events?type=trigger.failed' });
      expect((notices.json() as { events: Array<{ payload: unknown }> }).events).toHaveLength(1);
      const turns = await app.inject({ method: 'GET', url: `/api/agents/${chatOnly}/turns` });
      expect((turns.json() as { turns: unknown[] }).turns).toEqual([]);

      const byAgent = await app.inject({ method: 'GET', url: `/api/triggers/failures?agentId=${chatOnly}` });
      expect((byAgent.json() as { failures: unknown[] }).failures).toHaveLength(1);
      const byWorker = await app.inject({ method: 'GET', url: `/api/triggers/failures?agentId=${worker}` });
      expect((byWorker.json() as { failures: unknown[] }).failures).toEqual([]);
      const badLimit = await app.inject({ method: 'GET', url: '/api/triggers/failures?limit=0' });
      expect(badLimit.statusCode).toBe(400);
    } finally {
      launches.mockRestore();
    }
  }, 30_000);
});
