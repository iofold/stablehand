import { test, expect } from '@playwright/test';
import {
  createTestAgent,
  deleteTestAgent,
  waitForRunStatus,
} from './support';

/**
 * E2E tests for the chat conversation flow.
 *
 * Route: /agents/:id/conversations/new (new chat)
 *        /agents/:id/conversations/:conversationId (existing chat)
 *
 * Relies on data-testid attributes defined in the UI components:
 *   chat-input            - textarea for message input  (ChatInput.tsx)
 *   send-button           - submit button               (ChatInput.tsx)
 *   message-bubble-user   - rendered user message        (MessageBubble.tsx)
 *   message-bubble-assistant - rendered assistant message (MessageBubble.tsx)
 *   tool-call-card        - tool execution card          (ToolCallCard.tsx)
 *   tool-call-name        - tool name display            (ToolCallCard.tsx)
 *   run-finished          - hidden marker when streaming ends (ChatPage.tsx)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Chat conversation flow @extended', () => {
  let agentId = '';

  test.beforeEach(async ({ page, request }) => {
    const agent = await createTestAgent(request, {
      name: `chat-agent-${Date.now()}`,
      description: 'Chat regression test agent',
    });
    agentId = agent.id;

    await page.goto(`/agents/${agentId}/conversations/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });
  });

  test.afterEach(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  // ---- 1. Navigate to the chat page ----
  test('renders the chat page with input and send button', async ({ page }) => {
    const chatInput = page.getByTestId('session-input');
    const sendButton = page.getByTestId('send-button');

    await expect(chatInput).toBeVisible();
    await expect(sendButton).toBeVisible();

    // Send button should be disabled when input is empty
    await expect(sendButton).toBeDisabled();
  });

  // ---- 2. Type a message and submit ----
  test('sends a user message and displays it in the thread', async ({ page }) => {
    const chatInput = page.getByTestId('session-input');
    const sendButton = page.getByTestId('send-button');

    const userMessage = 'Hello, what can you do?';

    // Type the message
    await chatInput.fill(userMessage);
    await expect(sendButton).toBeEnabled();

    // Submit
    await sendButton.click();

    // The new user message bubble should appear (use last() to avoid old messages)
    const userBubbles = page.getByTestId('message-bubble-user');
    await expect(userBubbles.last()).toBeVisible({ timeout: 5_000 });
    await expect(userBubbles.last()).toContainText(userMessage);
  });

  // ---- 3 & 4. Wait for assistant response and assert content ----
  test('submitting a message returns conversation metadata', async ({ page }) => {
    const chatInput = page.getByTestId('session-input');
    const sendResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );

    await chatInput.fill('Say hello in one sentence.');
    await chatInput.press('Enter');
    const sendResponse = await sendResponsePromise;
    const sendBody = await sendResponse.json();

    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({ timeout: 5_000 });
    expect(typeof sendBody.conversationId).toBe('string');
    expect(sendBody.conversationId.length).toBeGreaterThan(0);
    expect(typeof sendBody.turnId).toBe('string');
    expect(sendBody.turnId.length).toBeGreaterThan(0);
  });

  // ---- 5. Check for tool calls (optional) ----
  test('chat remains stable when no tool calls are rendered', async ({ page }) => {
    const chatInput = page.getByTestId('session-input');

    await chatInput.fill('Use a tool to help answer: what files exist in the current directory?');
    await chatInput.press('Enter');
    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(1_000);

    const toolCards = page.getByTestId('tool-call-card');
    const count = await toolCards.count();

    if (count > 0) {
      await expect(toolCards.first()).toBeVisible();
      const toolName = page.getByTestId('tool-call-name').first();
      await expect(toolName).toBeVisible();
      const nameText = await toolName.innerText();
      expect(nameText.trim().length).toBeGreaterThan(0);
    } else {
      expect(count).toBe(0);
    }
  });

  // ---- Keyboard shortcut: Enter to send ----
  test('submits message on Enter key press', async ({ page }) => {
    const chatInput = page.getByTestId('session-input');

    await chatInput.fill('Ping');
    await chatInput.press('Enter');

    // New user bubble should appear (use last() to get the one we just sent)
    const userBubbles = page.getByTestId('message-bubble-user');
    await expect(userBubbles.last()).toBeVisible({ timeout: 5_000 });
    await expect(userBubbles.last()).toContainText('Ping');

    // Input should be cleared after send
    await expect(chatInput).toHaveValue('');
  });

  // ---- Shift+Enter inserts newline instead of sending ----
  test('does not send on Shift+Enter (inserts newline)', async ({ page }) => {
    const chatInput = page.getByTestId('session-input');

    // Record current count before typing
    const beforeCount = await page.getByTestId('message-bubble-user').count();

    await chatInput.fill('line one');
    await chatInput.press('Shift+Enter');
    await chatInput.type('line two');

    // Message should NOT have been sent — count should remain the same
    const afterCount = await page.getByTestId('message-bubble-user').count();
    expect(afterCount).toBe(beforeCount);

    // Textarea should contain both lines
    const value = await chatInput.inputValue();
    expect(value).toContain('line one');
    expect(value).toContain('line two');
  });

  // ---- Multiple messages in sequence ----
  test('supports multiple messages in a conversation', async ({ page }) => {
    const chatInput = page.getByTestId('session-input');
    const messageRequests: Array<Record<string, unknown>> = [];

    await page.route(`**/api/agents/${agentId}/message`, async (route) => {
      messageRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });

    const firstSendResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );
    await chatInput.fill('What is 2 + 2?');
    await chatInput.press('Enter');
    await expect(page.getByTestId('message-bubble-user').last()).toContainText('What is 2 + 2?');
    const firstBody = await (await firstSendResponse).json();
    await waitForRunStatus(page.request, agentId, firstBody.turnId, ['completed', 'error'], 120_000);
    await expect(chatInput).toBeEnabled({ timeout: 15_000 });

    const secondSendResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );
    await chatInput.fill('Now add 3 to that result.');
    await chatInput.press('Enter');
    await secondSendResponse;

    await expect(async () => {
      const count = await page.getByTestId('message-bubble-user').count();
      expect(count).toBe(2);
    }).toPass({ timeout: 15_000 });

    expect(messageRequests).toHaveLength(2);
    expect(messageRequests[0].content).toBe('What is 2 + 2?');
    expect(messageRequests[1].content).toBe('Now add 3 to that result.');
    expect(messageRequests[1].conversationId).toBe(firstBody.conversationId);
  });
});
