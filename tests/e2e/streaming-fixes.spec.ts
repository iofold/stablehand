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
const TURN_STATUSES = new Set(['ACTIVE', 'CHECKPOINTED', 'RESTORING', 'TERMINATED', 'COMPLETED', 'ERROR', 'CANCELLED', 'IDLE']);

test.describe('Streaming fixes @extended', () => {
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

  test('turns endpoint exposes distinct turn and sandbox identities', async ({ request }) => {
    const { conversationId, turnId } = await sendAgentMessage(
      request,
      agentId,
      'Reply with one short greeting.',
    );
    await waitForRunStatus(request, agentId, turnId, ['completed', 'error'], 90_000);

    const turnsResponse = await request.get(`${API_BASE}/api/agents/${agentId}/turns`);
    expect(turnsResponse.ok()).toBeTruthy();
    const turnsBody = await turnsResponse.json();

    const turns = (turnsBody as { turns?: Record<string, unknown>[] }).turns ?? [];
    expect(Array.isArray(turns)).toBe(true);
    expect(turns.length).toBeGreaterThan(0);

    const turn = turns.find((candidate: Record<string, unknown>) =>
      candidate.id === turnId,
    ) as Record<string, unknown> | undefined;

    expect(turn).toBeTruthy();
    expect(turn?.conversationId).toBe(conversationId);
    expect(turn?.agentId).toBe(agentId);
    expect(typeof turn?.status).toBe('string');
    expect(TURN_STATUSES.has(String(turn?.status))).toBe(true);
    expect(typeof turn?.mode).toBe('string');
    expect(turn).not.toHaveProperty('sessionId');
    expect(turn).not.toHaveProperty('sandboxSessionStatus');
    expect(turn?.startedAt).not.toBeNull();
    expect(turn?.startedAt).not.toBeUndefined();
    expect(Boolean(turn?.completedAt) || Boolean(turn?.error)).toBe(true);
  });

  test('sending a message streams in UI and completes', async ({ page }) => {
    await page.goto(`/agents/${agentId}/conversations/new`);
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

    await page.screenshot({ path: '.tmp/test-results/streaming-active.png' });

    await expect(page.getByTestId('run-finished')).toBeAttached({ timeout: 90_000 });
    await page.screenshot({ path: '.tmp/test-results/streaming-complete.png' });
  });

  test('completed conversation reload shows persisted messages', async ({ page, request }) => {
    const prompt = 'Say hello and mention reload works.';
    const { conversationId, turnId } = await sendAgentMessage(request, agentId, prompt);

    await waitForRunStatus(request, agentId, turnId, ['completed', 'error'], 90_000);
    await page.goto(`/agents/${agentId}/conversations/${conversationId}`);
    await page.waitForLoadState('domcontentloaded');

    const userBubbles = page.getByTestId('message-bubble-user');
    await expect(userBubbles.first()).toBeVisible({ timeout: 20_000 });
    await expect(userBubbles.first()).toContainText(prompt);

    await expect(async () => {
      expect(await page.getByTestId('message-bubble-assistant').count()).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000, intervals: [1_000, 2_000, 5_000] });

    await page.waitForTimeout(3_000);
    await page.screenshot({ path: '.tmp/test-results/completed-reload.png' });

    expect(await page.getByTestId('message-bubble-assistant').count()).toBeGreaterThan(0);
  });

  test('conversation snapshot keeps a consistent conversationId and replay boundary', async ({ request }) => {
    const { conversationId, turnId } = await sendAgentMessage(
      request,
      agentId,
      'Respond in one sentence about streaming.',
    );

    await waitForRunStatus(request, agentId, turnId, ['completed', 'error'], 90_000);

    const helperMessages = await getConversationMessages(request, agentId, conversationId);
    expect(helperMessages.length).toBeGreaterThan(0);

    const response = await request.get(
      `${API_BASE}/api/agents/${agentId}/conversations/${conversationId}/snapshot`,
    );
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.conversationId).toBe(conversationId);
    expect(body.eventCursor).toMatch(/^\d{12,15}$/);
    expect(body.messages.length).toBeGreaterThan(0);

    for (const message of body.messages as Array<Record<string, unknown>>) {
      expect(message.conversationId).toBe(conversationId);
    }
  });
});
