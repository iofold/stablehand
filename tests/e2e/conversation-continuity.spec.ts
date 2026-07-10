import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent, waitForRunStatus } from './support';

/**
 * E2E tests for conversation continuity — verifies that the second message
 * in a chat session includes the conversationId returned by the first message.
 *
 * Route: /agents/:id/conversations/new (new conversation)
 *        /agents/:id/conversations/:conversationId (continued conversation)
 */

test.describe('Conversation continuity @extended', () => {
  let agentId = '';

  test.beforeEach(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `continuity-agent-${Date.now()}`,
      description: 'Conversation continuity regression test agent',
    });
    agentId = agent.id;
  });

  test.afterEach(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('second message includes conversationId from first message response', async ({ page }) => {
    await page.goto(`/agents/${agentId}/conversations/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    const messageRequests: Array<{ body: Record<string, unknown> }> = [];

    await page.route(`**/api/agents/${agentId}/message`, async (route) => {
      const request = route.request();
      const postData = request.postDataJSON();
      messageRequests.push({ body: postData });
      // Continue the request normally
      await route.continue();
    });

    const chatInput = page.getByTestId('session-input');
    const firstSendResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );

    await chatInput.fill('What is 1 + 1?');
    await chatInput.press('Enter');
    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({ timeout: 5_000 });
    const firstResponse = await firstSendResponse;
    const firstResponseBody = await firstResponse.json();

    expect(messageRequests).toHaveLength(1);
    const firstBody = messageRequests[0].body;
    expect(firstBody.content).toBe('What is 1 + 1?');
    expect(typeof firstResponseBody.conversationId).toBe('string');
    expect(typeof firstResponseBody.sessionId).toBe('string');
    const firstRun = await waitForRunStatus(page.request, agentId, firstResponseBody.sessionId, ['completed', 'error'], 120_000);
    expect(firstRun.status).toBe('completed');
    await expect(chatInput).toBeEnabled({ timeout: 15_000 });

    const secondSendResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );
    await chatInput.fill('Now add 3 to that.');
    await chatInput.press('Enter');
    await expect(async () => {
      const count = await page.getByTestId('message-bubble-user').count();
      expect(count).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 10_000 });
    await secondSendResponse;

    expect(messageRequests).toHaveLength(2);
    const secondBody = messageRequests[1].body;
    expect(secondBody.content).toBe('Now add 3 to that.');
    expect(secondBody.conversationId).toBe(firstResponseBody.conversationId);
  });
});
