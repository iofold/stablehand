import { expect, test } from '@playwright/test';
import {
  API_BASE,
  createTestAgent,
  deleteTestAgent,
  getConversationMessages,
  sendAgentMessage,
  waitForRunStatus,
} from './support';

// This suite locks the route/SSE identity contract in docs/contracts/session-identity.md.
const SESSION_STATUSES = new Set(['ACTIVE', 'PAUSED', 'CHECKPOINTED', 'RESTORING', 'TERMINATED', 'COMPLETED', 'ERROR', 'CANCELLED', 'IDLE']);

test.describe('Streaming fixes', () => {
  let agentId = '';

  test.beforeEach(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `streaming-fixes-${Date.now()}`,
      description: 'Streaming regression test agent',
    });
    agentId = agent.id;
  });

  test.afterEach(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
      agentId = '';
    }
  });

  test('sessions and turns endpoints expose sandbox session shape', async ({ request }) => {
    const { conversationId, sessionId } = await sendAgentMessage(
      request,
      agentId,
      'Reply with one short greeting.',
    );
    await waitForRunStatus(request, agentId, sessionId, ['completed', 'error'], 90_000);

    const sessionsResponse = await request.get(`${API_BASE}/api/agents/${agentId}/sessions`);
    expect(sessionsResponse.ok()).toBeTruthy();
    const sessionsBody = await sessionsResponse.json();

    const sessions = Array.isArray(sessionsBody)
      ? sessionsBody
      : ((sessionsBody as Record<string, unknown>).sessions ?? []);

    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);

    const session = sessions.find((candidate: Record<string, unknown>) =>
      candidate.conversationId === conversationId || candidate.id === sessionId,
    ) as Record<string, unknown> | undefined;

    expect(session).toBeTruthy();
    expect(typeof session?.status).toBe('string');
    expect(SESSION_STATUSES.has(String(session?.status))).toBe(true);
    expect(session?.conversationId).toBe(conversationId);
    expect(session?.agentId).toBe(agentId);
    expect(typeof session?.mode).toBe('string');
    expect(session).not.toHaveProperty('sandboxSessionStatus');

    const turnsResponse = await request.get(`${API_BASE}/api/agents/${agentId}/turns`);
    expect(turnsResponse.ok()).toBeTruthy();
    const turnsBody = await turnsResponse.json();

    expect(Array.isArray(turnsBody)).toBe(true);
    expect(turnsBody.length).toBeGreaterThan(0);

    const turn = turnsBody.find((candidate: Record<string, unknown>) =>
      candidate.id === sessionId || candidate.conversationId === conversationId,
    ) as Record<string, unknown> | undefined;

    expect(turn).toBeTruthy();
    expect(turn?.startedAt).not.toBeNull();
    expect(turn?.startedAt).not.toBeUndefined();
    expect(Boolean(turn?.completedAt) || Boolean(turn?.error)).toBe(true);
  });

  test('sending a message streams in UI and completes', async ({ page }) => {
    await page.goto(`/agents/${agentId}/sessions/new`);
    const input = page.getByTestId('session-input');

    await expect(input).toBeVisible({ timeout: 15_000 });

    const sendResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );

    await input.fill('Say hello briefly');
    await input.press('Enter');
    await sendResponsePromise;

    const userBubbles = page.getByTestId('message-bubble-user');
    await expect(userBubbles.last()).toContainText('Say hello briefly', { timeout: 10_000 });

    await expect(async () => {
      expect(await page.getByTestId('message-bubble-assistant').count()).toBeGreaterThan(0);
    }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] });

    await page.screenshot({ path: 'test-results/streaming-active.png' });

    await expect(page.getByTestId('run-finished')).toBeAttached({ timeout: 90_000 });
    await page.screenshot({ path: 'test-results/streaming-complete.png' });
  });

  test('completed conversation reload shows persisted messages', async ({ page, request }) => {
    const prompt = 'Say hello and mention reload works.';
    const { conversationId, sessionId } = await sendAgentMessage(request, agentId, prompt);

    await waitForRunStatus(request, agentId, sessionId, ['completed', 'error'], 90_000);
    await page.goto(`/agents/${agentId}/sessions/${conversationId}`);
    await page.waitForLoadState('domcontentloaded');

    const userBubbles = page.getByTestId('message-bubble-user');
    await expect(userBubbles.first()).toBeVisible({ timeout: 20_000 });
    await expect(userBubbles.first()).toContainText(prompt);

    await expect(async () => {
      expect(await page.getByTestId('message-bubble-assistant').count()).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000, intervals: [1_000, 2_000, 5_000] });

    await page.waitForTimeout(3_000);
    await page.screenshot({ path: 'test-results/completed-reload.png' });

    expect(await page.getByTestId('message-bubble-assistant').count()).toBeGreaterThan(0);
  });

  test('conversation messages endpoint keeps a consistent conversationId', async ({ request }) => {
    const { conversationId, sessionId } = await sendAgentMessage(
      request,
      agentId,
      'Respond in one sentence about streaming.',
    );

    await waitForRunStatus(request, agentId, sessionId, ['completed', 'error'], 90_000);

    const helperMessages = await getConversationMessages(request, agentId, conversationId);
    expect(helperMessages.length).toBeGreaterThan(0);

    const response = await request.get(
      `${API_BASE}/api/agents/${agentId}/conversations/${conversationId}/messages`,
    );
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);

    for (const message of body as Array<Record<string, unknown>>) {
      expect(message.conversationId).toBe(conversationId);
    }
  });
});
