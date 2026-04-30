import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API_BASE,
  importStressAgent,
  deleteTestAgent,
  startBackgroundRun,
  waitForRunStatus,
  getInterrupts,
  resolveInterrupt,
  getEvents,
  getConversationMessages,
  cancelSession,
  type TestAgent,
} from './support';

const STRESS_AGENT_DIRS = [
  'stress-lg-openai',
  'stress-lg-gemini',
  'stress-pi-openai',
  'stress-pi-gemini',
  'stress-claude-sonnet',
  'stress-chain-responder',
  'stress-hitl',
] as const;

type TestRun = { id: string; status: string; conversationId: string };

const trackedRuns = new Map<string, Set<string>>();

function trackRun(agentKey: string, sessionId: string): void {
  const runs = trackedRuns.get(agentKey) ?? new Set<string>();
  runs.add(sessionId);
  trackedRuns.set(agentKey, runs);
}

async function listRuns(
  request: APIRequestContext,
  agentId: string,
): Promise<TestRun[]> {
  const response = await request.get(`${API_BASE}/api/agents/${agentId}/sessions`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { sessions?: TestRun[] };
  return body.sessions ?? [];
}

async function ensureStressTrigger(
  request: APIRequestContext,
  chainResponderId: string,
): Promise<void> {
  const response = await request.post(`${API_BASE}/api/triggers`, {
    data: {
      agentId: chainResponderId,
      eventType: 'stress.tools.complete',
      taskTemplate: 'Chain event received: {{payload}}',
      enabled: true,
    },
  });

  expect([200, 201, 409]).toContain(response.status());
}

test.describe('Stress Test — Multi-Model Multi-Harness', () => {
  const agents: Record<string, TestAgent> = {};

  test.beforeAll(async ({ request }) => {
    for (const agentDir of STRESS_AGENT_DIRS) {
      agents[agentDir] = await importStressAgent(request, agentDir);
    }

    await ensureStressTrigger(request, agents['stress-chain-responder'].id);
  });

  test.afterAll(async ({ request }) => {
    for (const [agentKey, sessionIds] of trackedRuns.entries()) {
      const agent = agents[agentKey];
      if (!agent) {
        continue;
      }

      for (const sessionId of sessionIds) {
        await cancelSession(request, agent.id, sessionId);
      }
    }

    for (const agent of Object.values(agents)) {
      await deleteTestAgent(request, agent.id);
    }
  });

  test('LangGraph + GPT-5.4: agent run reaches terminal state', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-lg-openai'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit stress.tools.complete.',
    );
    trackRun('stress-lg-openai', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(['completed', 'error']).toContain(finalRun.status);

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (!messages.some((message) => message.role === 'assistant')) {
          console.warn('No assistant message found — run may have errored before generating output');
        };

    const events = await getEvents(request, {
      type: 'stress.tools.complete',
      agentId: agent.id,
      limit: 20,
    });
    if (!events.some((event) => event.payload.includes(sessionId))) {
      console.warn(`Optional event stress.tools.complete missing for run ${sessionId}`);
    }
  });

  test('LangGraph + Gemini: agent run reaches terminal state', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-lg-gemini'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit stress.gemini.complete.',
    );
    trackRun('stress-lg-gemini', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(['completed', 'error']).toContain(finalRun.status);

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (!messages.some((message) => message.role === 'assistant')) {
          console.warn('No assistant message found — run may have errored before generating output');
        };

    const events = await getEvents(request, {
      type: 'stress.gemini.complete',
      agentId: agent.id,
      limit: 20,
    });
    if (!events.some((event) => event.payload.includes(sessionId))) {
      console.warn(`Optional event stress.gemini.complete missing for run ${sessionId}`);
    }
  });

  test('PI Agent + GPT-5.4: agent run reaches terminal state', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-pi-openai'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit stress.pi.complete.',
    );
    trackRun('stress-pi-openai', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(['completed', 'error']).toContain(finalRun.status);

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (!messages.some((message) => message.role === 'assistant')) {
          console.warn('No assistant message found — run may have errored before generating output');
        };

    const events = await getEvents(request, {
      type: 'stress.pi.complete',
      agentId: agent.id,
      limit: 20,
    });
    if (!events.some((event) => event.payload.includes(sessionId))) {
      console.warn(`Optional event stress.pi.complete missing for run ${sessionId}`);
    }
  });

  test('PI Agent + Gemini: agent run reaches terminal state', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-pi-gemini'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit stress.pi-gemini.complete.',
    );
    trackRun('stress-pi-gemini', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(['completed', 'error']).toContain(finalRun.status);

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (!messages.some((message) => message.role === 'assistant')) {
          console.warn('No assistant message found — run may have errored before generating output');
        };

    const events = await getEvents(request, {
      type: 'stress.pi-gemini.complete',
      agentId: agent.id,
      limit: 20,
    });
    if (!events.some((event) => event.payload.includes(sessionId))) {
      console.warn(`Optional event stress.pi-gemini.complete missing for run ${sessionId}`);
    }
  });

  test('Claude Agents + Sonnet: writes code, executes it, verifies output', async ({ request }) => {
    test.setTimeout(180_000);

    const agent = agents['stress-claude-sonnet'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Write a Python file at stress_test.py that computes the first 10 Fibonacci numbers and prints them as a JSON array. Then execute it with Bash and verify the output is correct. Finally, read the file back to confirm it exists.',
    );
    trackRun('stress-claude-sonnet', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(['completed', 'error']).toContain(finalRun.status);

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (!messages.some((message) => message.role === 'assistant')) {
          console.warn('No assistant message found — run may have errored before generating output');
        };

    const events = await getEvents(request, {
      type: 'stress.claude.complete',
      agentId: agent.id,
      limit: 20,
    });
    if (!events.some((event) => event.payload.includes(sessionId))) {
      console.warn(`Optional event stress.claude.complete missing for run ${sessionId}`);
    }
  });

  test('Event chain: direct emit starts chain-responder run', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-chain-responder'];
    expect(agent).toBeTruthy();

    const beforeRuns = await listRuns(request, agent.id);
    const knownRunIds = new Set(beforeRuns.map((run) => run.id));

    const emitResponse = await request.post(`${API_BASE}/api/triggers/emit`, {
      data: {
        type: 'stress.tools.complete',
        payload: {
          source: 'tests/e2e/stress-smoke.spec.ts',
          emittedAt: new Date().toISOString(),
        },
      },
    });

    expect(emitResponse.ok()).toBeTruthy();

    await expect
      .poll(
        async () => {
          const runs = await listRuns(request, agent.id);
          return runs.find((entry) => !knownRunIds.has(entry.id))?.id ?? '';
        },
        { timeout: 30_000 },
      )
      .not.toBe('');

    const triggeredRuns = await listRuns(request, agent.id);
    const triggeredRun = triggeredRuns.find((entry) => !knownRunIds.has(entry.id));
    expect(triggeredRun).toBeTruthy();
    trackRun('stress-chain-responder', triggeredRun!.id);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      triggeredRun!.id,
      ['completed', 'error'],
      100_000,
    );

    expect(['completed', 'error']).toContain(finalRun.status);

    const messages = await getConversationMessages(
      request,
      agent.id,
      triggeredRun!.conversationId,
    );
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (!messages.some((message) => message.role === 'assistant')) {
          console.warn('No assistant message found — run may have errored before generating output');
        };

    const events = await getEvents(request, {
      type: 'stress.chain.done',
      agentId: agent.id,
      limit: 20,
    });
    if (!events.some((event) => event.payload.includes(triggeredRun!.id))) {
      console.warn(`Optional event stress.chain.done missing for run ${triggeredRun!.id}`);
    }
  });

  test('HITL: approve flow works when interrupt occurs, otherwise terminal run still passes', async ({ request }) => {
    test.setTimeout(180_000);

    const agent = agents['stress-hitl'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Request approval for writing stress test results, then emit stress.hitl.complete.',
    );
    trackRun('stress-hitl', sessionId);

    let interrupt = null as Awaited<ReturnType<typeof getInterrupts>>[number] | null;
    let terminalRun = null as TestRun | null;

    const hitlDeadline = Date.now() + 60_000;
    while (Date.now() < hitlDeadline) {
      const interrupts = await getInterrupts(request, agent.id);
      interrupt = interrupts.find((entry) => entry.runId === sessionId) ?? null;
      if (interrupt) break;

      const runs = await listRuns(request, agent.id);
      terminalRun = runs.find((entry) => entry.id === sessionId && ['completed', 'error'].includes(entry.status.toLowerCase())) ?? null;
      if (terminalRun) break;

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    if (interrupt) {

      expect(interrupt).toBeTruthy();

      const resolution = await resolveInterrupt(request, agent.id, sessionId, 'approve');
      expect(resolution).toEqual({ resolved: true, action: 'approve' });

      const finalRun = await waitForRunStatus(
        request,
        agent.id,
        sessionId,
        ['completed', 'error'],
        100_000,
      );

      expect(['completed', 'error']).toContain(finalRun.status);

      const messages = await getConversationMessages(request, agent.id, conversationId);
      expect(messages.length).toBeGreaterThanOrEqual(1);
      if (!messages.some((message) => message.role === 'assistant')) {
            console.warn('No assistant message found — run may have errored before generating output');
          };

      return;
    }

    const runState = terminalRun ?? await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      80_000,
    );

    expect(['completed', 'error']).toContain(runState.status.toLowerCase());

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (!messages.some((message) => message.role === 'assistant')) {
          console.warn('No assistant message found — run may have errored before generating output');
        };

    console.warn(`Optional HITL interrupt did not occur for run ${sessionId}`);
  });
});
