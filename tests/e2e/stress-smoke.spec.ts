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
  cancelTurn,
  releaseAgentSandboxes,
  type TestAgent,
} from './support';
import {
  assertStressComplete,
  fetchStressEventsForTurn,
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

function trackRun(agentKey: string, turnId: string): void {
  const runs = trackedRuns.get(agentKey) ?? new Set<string>();
  runs.add(turnId);
  trackedRuns.set(agentKey, runs);
}

async function listRuns(
  request: APIRequestContext,
  agentId: string,
): Promise<TestRun[]> {
  const response = await request.get(`${API_BASE}/api/agents/${agentId}/turns`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { turns?: TestRun[] };
  return body.turns ?? [];
}

type PersistedMessage = {
  id: string;
  role: string;
  content: string | null;
  parts?: Array<{ type: string; toolCallId?: string; id?: string }> | null;
};

async function assertRegistryToolExecution(
  request: APIRequestContext,
  agentId: string,
  conversationId: string,
): Promise<void> {
  const response = await request.get(
    `${API_BASE}/api/agents/${agentId}/conversations/${conversationId}/snapshot`,
  );
  expect(response.ok()).toBeTruthy();
  const snapshot = (await response.json()) as { messages: PersistedMessage[] };
  const messages = snapshot.messages;

  const toolResults = messages
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content ?? ''));
  const placeholderFailures = toolResults.filter(
    (content) => content.includes('was called directly') || content.includes('execution failed'),
  );
  expect(
    placeholderFailures,
    `[ctx-5xyo] registry tool calls must execute their real handler, got: ${placeholderFailures[0] ?? ''}`,
  ).toEqual([]);
  // Models occasionally pick their own operands, so assert the handler's
  // result format rather than one exact value — a real computed result can
  // only come from the registry handler actually executing.
  const calculatorResults = toolResults.filter((content) =>
    /-?\d+(\.\d+)? (add|subtract|multiply|divide) -?\d+(\.\d+)? = -?\d+/.test(content));
  expect(
    calculatorResults.length,
    `[ctx-5xyo] expected at least one real persisted calculator result in tool messages: ${JSON.stringify(toolResults)}`,
  ).toBeGreaterThan(0);

  const toolCallIds = messages.flatMap((message) => (message.parts ?? [])
    .filter((part) => part.type === 'tool_call')
    .map((part) => part.toolCallId ?? part.id ?? ''));
  const duplicates = toolCallIds.filter((id, index) => id && toolCallIds.indexOf(id) !== index);
  expect(
    duplicates,
    `[ctx-hb4b] each tool invocation must persist exactly one tool_call part, duplicates: ${JSON.stringify(duplicates)}`,
  ).toEqual([]);
}

async function ensureStressTrigger(
  request: APIRequestContext,
  chainResponderId: string,
): Promise<void> {
  for (const eventType of ['stress.tools.complete', 'custom.stress.tools.complete']) {
    const response = await request.post(`${API_BASE}/api/triggers`, {
      data: {
        agentId: chainResponderId,
        eventType,
        taskTemplate: 'Chain event received: {{payload}}. Acknowledge it by emitting exactly one stress.chain.done event with payload {"schemaVersion":1,"harness":"stress-chain-responder","agent":"stress-chain-responder","model":"gpt-5.4","status":"ok"}.',
        enabled: true,
      },
    });

    expect([200, 201, 409]).toContain(response.status());
  }
}

// These tests make real model calls. Without provider keys (e.g. CI before the repo
// secrets exist) they skip with a reason instead of failing the smoke gate.
const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY;
const HAS_ANTHROPIC_KEY = !!process.env.ANTHROPIC_API_KEY;
const NO_OPENAI_KEY = 'OPENAI_API_KEY not set: this test makes real OpenAI calls';
const NO_ANTHROPIC_KEY = 'ANTHROPIC_API_KEY not set: this test makes real Anthropic calls';

test.describe('Stress Test — Multi-Model Multi-Harness', () => {
  test.skip(!HAS_OPENAI_KEY && !HAS_ANTHROPIC_KEY, 'No provider keys set: every test here makes real model calls');
  const agents: Record<string, TestAgent> = {};

  test.beforeAll(async ({ request }) => {
    for (const agentDir of STRESS_AGENT_DIRS) {
      agents[agentDir] = await importStressAgent(request, agentDir);
    }

    await ensureStressTrigger(request, agents['stress-chain-responder'].id);
  });

  test.afterEach(async ({ request }) => {
    // Completed runs keep their sandbox warm for the idle window, so retained
    // smoke sandboxes starve later cases on a small node (ctx-7o33). Release
    // every stress-agent sandbox — including the trigger-spawned chain
    // responder's — before the next case starts.
    await releaseAgentSandboxes(request, Object.values(agents).map((agent) => agent.id));
  });

  test.afterAll(async ({ request }) => {
    for (const [agentKey, turnIds] of trackedRuns.entries()) {
      const agent = agents[agentKey];
      if (!agent) {
        continue;
      }

      for (const turnId of turnIds) {
        await cancelTurn(request, agent.id, turnId);
      }
    }

    for (const agent of Object.values(agents)) {
      await deleteTestAgent(request, agent.id);
    }
  });

  test('LangGraph + GPT-5.4: required-matrix stress.tools.complete @smoke', async ({ request }) => {
    test.skip(!HAS_OPENAI_KEY, NO_OPENAI_KEY);
    test.setTimeout(120_000);

    const agent = agents['stress-lg-openai'];
    expect(agent).toBeTruthy();

    const { turnId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now, including the calculator step. Confirm you are operational and emit stress.tools.complete.',
    );
    trackRun('stress-lg-openai', turnId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      turnId,
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
      turnId,
      'stress.tools.complete',
      'stress-lg-openai',
      { agentId: agent.id },
    );

    await assertRegistryToolExecution(request, agent.id, conversationId);
  });

  test('LangGraph + Gemini: extended stress.gemini.complete @extended', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-lg-gemini'];
    expect(agent).toBeTruthy();

    const { turnId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit stress.gemini.complete.',
    );
    trackRun('stress-lg-gemini', turnId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      turnId,
      ['completed', 'error'],
      100_000,
    );

    expect(finalRun.status).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    const matches = await fetchStressEventsForTurn(
      request,
      'stress.gemini.complete',
      turnId,
      { agentId: agent.id },
    );
    expect(
      matches.length,
      `[ADR-012] expected exactly one stress.gemini.complete event for turn ${turnId}, got ${matches.length}`,
    ).toBe(1);
  });

  test('PI Agent + GPT-5.4: required-matrix stress.pi.complete @smoke', async ({ request }) => {
    test.skip(!HAS_OPENAI_KEY, NO_OPENAI_KEY);
    test.setTimeout(120_000);

    const agent = agents['stress-pi-openai'];
    expect(agent).toBeTruthy();

    const { turnId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now, including the calculator step. Confirm you are operational and emit exactly one stress.pi.complete event with payload {"schemaVersion":1,"harness":"stress-pi-openai","agent":"stress-pi-openai","model":"gpt-5.4","status":"ok"}.',
    );
    trackRun('stress-pi-openai', turnId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      turnId,
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
      turnId,
      'stress.pi.complete',
      'stress-pi-openai',
      { agentId: agent.id },
    );

    await assertRegistryToolExecution(request, agent.id, conversationId);
  });

  test('PI Agent + Gemini: extended stress.pi-gemini.complete @extended', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-pi-gemini'];
    expect(agent).toBeTruthy();

    const { turnId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Run the stress test now. Confirm you are operational and emit exactly one stress.pi-gemini.complete event with payload {"schemaVersion":1,"harness":"stress-pi-gemini","agent":"stress-pi-gemini","model":"gemini-2.5-flash","status":"ok"}.',
    );
    trackRun('stress-pi-gemini', turnId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      turnId,
      ['completed', 'error'],
      100_000,
    );

    expect(finalRun.status).toBe('completed');

    const messages = await getConversationMessages(request, agent.id, conversationId);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);

    const matches = await fetchStressEventsForTurn(
      request,
      'stress.pi-gemini.complete',
      turnId,
      { agentId: agent.id },
    );
    expect(
      matches.length,
      `[ADR-012] expected exactly one stress.pi-gemini.complete event for turn ${turnId}, got ${matches.length}`,
    ).toBe(1);
  });

  test('Claude Agents + Sonnet: required-matrix stress.claude.complete @smoke', async ({ request }) => {
    test.skip(!HAS_ANTHROPIC_KEY, NO_ANTHROPIC_KEY);
    test.setTimeout(180_000);

    const agent = agents['stress-claude-sonnet'];
    expect(agent).toBeTruthy();

    const { turnId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Write a Python file at /workspace/stress_test.py that computes the first 10 Fibonacci numbers and prints them as a JSON array. Then execute it with Bash, verify the output is correct, and read the file back to confirm it exists. Then use the calculator tool exactly once to multiply 42 by 17. Finally emit exactly one stress.claude.complete event with payload {"schemaVersion":1,"harness":"stress-claude-sonnet","agent":"stress-claude-sonnet","model":"claude-sonnet-4-6","status":"ok"}.',
    );
    trackRun('stress-claude-sonnet', turnId);

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      turnId,
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
      turnId,
      'stress.claude.complete',
      'stress-claude-sonnet',
      { agentId: agent.id },
    );

    await assertRegistryToolExecution(request, agent.id, conversationId);
  });

  test('Event chain: direct emit starts chain-responder run @extended', async ({ request }) => {
    test.setTimeout(120_000);

    const agent = agents['stress-chain-responder'];
    expect(agent).toBeTruthy();

    const beforeRuns = await listRuns(request, agent.id);
    const knownRunIds = new Set(beforeRuns.map((run) => run.id));

    const emitResponse = await request.post(`${API_BASE}/api/triggers/emit`, {
      data: {
        type: 'custom.stress.tools.complete',
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

    const matches = await fetchStressEventsForTurn(
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
    test.skip(!HAS_OPENAI_KEY, NO_OPENAI_KEY);
    test.setTimeout(180_000);

    const agent = agents['stress-hitl'];
    expect(agent).toBeTruthy();

    const { turnId, conversationId } = await startBackgroundRun(
      request,
      agent.id,
      'Request approval for writing stress test results, then emit stress.hitl.complete.',
    );
    trackRun('stress-hitl', turnId);

    let interrupt = null as Awaited<ReturnType<typeof getInterrupts>>[number] | null;

    const hitlDeadline = Date.now() + 60_000;
    while (Date.now() < hitlDeadline) {
      const interrupts = await getInterrupts(request, agent.id);
      interrupt = interrupts.find((entry) => entry.turnId === turnId) ?? null;
      if (interrupt) break;

      const runs = await listRuns(request, agent.id);
      const terminal = runs.find((entry) =>
        entry.id === turnId &&
        ['completed', 'error'].includes(entry.status.toLowerCase()),
      );
      if (terminal) break;

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    expect(
      interrupt,
      `[ADR-011] HITL extended test requires an interrupt to occur for turn ${turnId}`,
    ).toBeTruthy();

    const resolution = await resolveInterrupt(request, agent.id, interrupt!.interruptId, 'approve');
    expect(resolution).toEqual({ resolved: true, action: 'approve' });

    const finalRun = await waitForRunStatus(
      request,
      agent.id,
      turnId,
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
    const turnMatches = matches.filter((event) => (event.payload ?? '').includes(turnId));
    expect(
      turnMatches.length,
      `[ADR-012] expected exactly one stress.hitl.complete event for turn ${turnId}, got ${turnMatches.length}`,
    ).toBe(1);
  });
});
