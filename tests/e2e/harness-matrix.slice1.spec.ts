import { test, expect } from '@playwright/test';

import {
  API_BASE,
  cancelTurn,
  deleteTestAgent,
  getConversationMessages,
  importStressAgent,
  startBackgroundRun,
  waitForRunStatus,
  type TestAgent,
} from './support';

type HarnessSliceCase = {
  agentDir: 'stress-lg-openai' | 'stress-claude-sonnet' | 'stress-pi-openai';
  prompt: string;
  expectedEventType: string;
};

const SLICE_1_CASES: HarnessSliceCase[] = [
  {
    agentDir: 'stress-lg-openai',
    prompt: 'Run the matrix slice smoke test now. Confirm you are operational and emit exactly one stress.tools.complete event with payload {"schemaVersion":1,"harness":"stress-lg-openai","agent":"stress-lg-openai","model":"gpt-5.4","status":"ok"}.',
    expectedEventType: 'stress.tools.complete',
  },
  {
    agentDir: 'stress-claude-sonnet',
    prompt: 'Confirm you are operational, emit exactly one stress.claude.complete event with payload {"schemaVersion":1,"harness":"stress-claude-sonnet","agent":"stress-claude-sonnet","model":"claude-sonnet-4-6","status":"ok"}, then say the matrix slice is complete.',
    expectedEventType: 'stress.claude.complete',
  },
  {
    agentDir: 'stress-pi-openai',
    prompt: 'Run the matrix slice smoke test now. Confirm you are operational and emit exactly one stress.pi.complete event with payload {"schemaVersion":1,"harness":"stress-pi-openai","agent":"stress-pi-openai","model":"gpt-5.4","status":"ok"}.',
    expectedEventType: 'stress.pi.complete',
  },
];

test.describe('Harness matrix slice 1 — fresh turns across native harnesses @extended', () => {
  const agents: Partial<Record<HarnessSliceCase['agentDir'], TestAgent>> = {};
  const runsByAgent = new Map<string, Set<string>>();

  test.beforeAll(async ({ request }) => {
    for (const testCase of SLICE_1_CASES) {
      agents[testCase.agentDir] = await importStressAgent(request, testCase.agentDir);
    }
  });

  test.afterAll(async ({ request }) => {
    for (const [agentDir, runIds] of runsByAgent.entries()) {
      const agent = agents[agentDir as HarnessSliceCase['agentDir']];
      if (!agent) continue;
      for (const runId of runIds) {
        await cancelTurn(request, agent.id, runId);
      }
    }

    for (const agent of Object.values(agents)) {
      if (agent) {
        await deleteTestAgent(request, agent.id);
      }
    }
  });

  for (const testCase of SLICE_1_CASES) {
    test(`${testCase.agentDir} completes a fresh background run @extended`, async ({ request }) => {
      test.setTimeout(180_000);

      const agent = agents[testCase.agentDir];
      expect(agent).toBeTruthy();

      const { turnId, conversationId } = await startBackgroundRun(request, agent!.id, testCase.prompt);
      const runs = runsByAgent.get(testCase.agentDir) ?? new Set<string>();
      runs.add(turnId);
      runsByAgent.set(testCase.agentDir, runs);

      const finalRun = await waitForRunStatus(request, agent!.id, turnId, ['completed', 'error'], 150_000);
      expect(finalRun.status).toBe('completed');

      const messages = await getConversationMessages(request, agent!.id, conversationId);
      const assistantMessages = messages.filter((message) => message.role === 'assistant');
      expect(assistantMessages.length).toBeGreaterThan(0);

      const eventsResponse = await request.get(`${API_BASE}/api/events?type=${encodeURIComponent(testCase.expectedEventType)}&agentId=${encodeURIComponent(agent!.id)}&limit=20`);
      expect(eventsResponse.ok()).toBe(true);
      const eventsBody = await eventsResponse.json() as { events?: Array<{ payload?: string }> };
      expect(eventsBody.events?.some((event) => (event.payload ?? '').includes(turnId))).toBe(true);
    });
  }
});
