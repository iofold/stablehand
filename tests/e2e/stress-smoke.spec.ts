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
import {
  assertStressComplete,
  fetchStressEventsForSession,
} from './helpers/stress-event';

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
      taskTemplate: 'Chain event received: {{payload}}. Acknowledge it by emitting exactly one stress.chain.done event with payload {"schemaVersion":1,"harness":"stress-chain-responder","agent":"stress-chain-responder","model":"gpt-5.4","status":"ok"}.',
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

  test('LangGraph + GPT-5.4: required-matrix stress.tools.complete @smoke', async ({ request }) => {
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

    expect(
      finalRun.status,
      `[ADR-011] required-matrix run must reach completed, got ${finalRun.status}`,
    ).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    await assertStressComplete(
      request,
      sessionId,
      'stress.tools.complete',
      'stress-lg-openai',
      { agentId: agent.id },
    );
  });

  test('LangGraph + Gemini: extended stress.gemini.complete @extended', async ({ request }) => {
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

    expect(finalRun.status).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    const matches = await fetchStressEventsForSession(
      request,
      'stress.gemini.complete',
      sessionId,
      { agentId: agent.id },
    );
    expect(
      matches.length,
      `[ADR-012] expected exactly one stress.gemini.complete event for session ${sessionId}, got ${matches.length}`,
    ).toBe(1);
  });

  test('PI Agent + GPT-5.4: required-matrix stress.pi.complete @smoke', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-pi-openai'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit exactly one stress.pi.complete event with payload {"schemaVersion":1,"harness":"stress-pi-openai","agent":"stress-pi-openai","model":"gpt-5.4","status":"ok"}.',
    );
    trackRun('stress-pi-openai', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(
      finalRun.status,
      `[ADR-011] required-matrix run must reach completed, got ${finalRun.status}`,
    ).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    await assertStressComplete(
      request,
      sessionId,
      'stress.pi.complete',
      'stress-pi-openai',
      { agentId: agent.id },
    );
  });

  test('PI Agent + Gemini: extended stress.pi-gemini.complete @extended', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-pi-gemini'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit exactly one stress.pi-gemini.complete event with payload {"schemaVersion":1,"harness":"stress-pi-gemini","agent":"stress-pi-gemini","model":"gemini-2.5-flash","status":"ok"}.',
    );
    trackRun('stress-pi-gemini', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(finalRun.status).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    const matches = await fetchStressEventsForSession(
      request,
      'stress.pi-gemini.complete',
      sessionId,
      { agentId: agent.id },
    );
    expect(
      matches.length,
      `[ADR-012] expected exactly one stress.pi-gemini.complete event for session ${sessionId}, got ${matches.length}`,
    ).toBe(1);
  });

  test('Claude Agents + Sonnet: required-matrix stress.claude.complete @smoke', async ({ request }) => {
    test.setTimeout(180_000);

    const agent = agents['stress-claude-sonnet'];
    expect(agent).toBeTruthy();

    const { sessionId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Write a Python file at /workspace/stress_test.py that computes the first 10 Fibonacci numbers and prints them as a JSON array. Then execute it with Bash, verify the output is correct, and read the file back to confirm it exists. Finally emit exactly one stress.claude.complete event with payload {"schemaVersion":1,"harness":"stress-claude-sonnet","agent":"stress-claude-sonnet","model":"claude-sonnet-4-6","status":"ok"}.',
    );
    trackRun('stress-claude-sonnet', sessionId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(
      finalRun.status,
      `[ADR-011] required-matrix run must reach completed, got ${finalRun.status}`,
    ).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    await assertStressComplete(
      request,
      sessionId,
      'stress.claude.complete',
      'stress-claude-sonnet',
      { agentId: agent.id },
    );
  });

  test('Event chain: direct emit starts chain-responder run @extended', async ({ request }) => {
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

    expect(finalRun.status).toBe('completed');

    const messages = await getConversationMessages(
      request,
      agent.id,
      triggeredRun!.conversationId,
    );
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    const matches = await fetchStressEventsForSession(
      request,
      'stress.chain.done',
      triggeredRun!.id,
      { agentId: agent.id },
    );
    expect(
      matches.length,
      `[ADR-012] expected exactly one stress.chain.done event for run ${triggeredRun!.id}, got ${matches.length}`,
    ).toBe(1);
  });

  test('HITL: approve flow emits stress.hitl.complete deterministically @smoke @extended', async ({ request }) => {
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

    const hitlDeadline = Date.now() + 60_000;
    while (Date.now() < hitlDeadline) {
      const interrupts = await getInterrupts(request, agent.id);
      interrupt = interrupts.find((entry) => entry.runId === sessionId) ?? null;
      if (interrupt) break;

      const runs = await listRuns(request, agent.id);
      const terminal = runs.find((entry) =>
        entry.id === sessionId &&
        ['completed', 'error'].includes(entry.status.toLowerCase()),
      );
      if (terminal) break;

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    expect(
      interrupt,
      `[ADR-011] HITL extended test requires an interrupt to occur for session ${sessionId}`,
    ).toBeTruthy();

    const resolution = await resolveInterrupt(request, agent.id, sessionId, 'approve');
    expect(resolution).toEqual({ resolved: true, action: 'approve' });

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      sessionId,
      ['completed', 'error'],
      100_000,
    );

    expect(finalRun.status).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    const matches = await getEvents(request, {
      type: 'stress.hitl.complete',
      agentId: agent.id,
      limit: 50,
    });
    const sessionMatches = matches.filter((event) => (event.payload ?? '').includes(sessionId));
    expect(
      sessionMatches.length,
      `[ADR-012] expected exactly one stress.hitl.complete event for session ${sessionId}, got ${sessionMatches.length}`,
    ).toBe(1);
  });
});
