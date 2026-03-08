import { test, expect } from '@playwright/test';

/**
 * E2E tests for the chat conversation flow.
 *
 * Route: /agents/:id/chat
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

/** Default agent id used by the dev seed / fixture. Override via AGENT_ID env. */
const AGENT_ID = process.env.AGENT_ID ?? 'explorer';
const CHAT_URL = `/agents/${AGENT_ID}/chat`;

/** Timeout for waiting on an assistant response (LLM latency). */
const RESPONSE_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Chat conversation flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CHAT_URL);

    // Wait for the chat input to be visible (page fully loaded)
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 });
  });

  // ---- 1. Navigate to the chat page ----
  test('renders the chat page with input and send button', async ({ page }) => {
    const chatInput = page.getByTestId('chat-input');
    const sendButton = page.getByTestId('send-button');

    await expect(chatInput).toBeVisible();
    await expect(sendButton).toBeVisible();

    // Send button should be disabled when input is empty
    await expect(sendButton).toBeDisabled();
  });

  // ---- 2. Type a message and submit ----
  test('sends a user message and displays it in the thread', async ({ page }) => {
    const chatInput = page.getByTestId('chat-input');
    const sendButton = page.getByTestId('send-button');

    const userMessage = 'Hello, what can you do?';

    // Type the message
    await chatInput.fill(userMessage);
    await expect(sendButton).toBeEnabled();

    // Submit
    await sendButton.click();

    // The user message bubble should appear
    const userBubble = page.getByTestId('message-bubble-user');
    await expect(userBubble.first()).toBeVisible({ timeout: 5_000 });
    await expect(userBubble.first()).toContainText(userMessage);
  });

  // ---- 3 & 4. Wait for assistant response and assert content ----
  test('receives an assistant response with text content', async ({ page }) => {
    const chatInput = page.getByTestId('chat-input');

    // Send a message
    await chatInput.fill('Say hello in one sentence.');
    await chatInput.press('Enter');

    // Wait for user bubble to appear first
    await expect(page.getByTestId('message-bubble-user').first()).toBeVisible({ timeout: 5_000 });

    // Wait for the assistant response. The run-finished marker appears when
    // streaming completes and at least one message exists.
    await expect(page.getByTestId('run-finished')).toBeAttached({
      timeout: RESPONSE_TIMEOUT,
    });

    // At least one assistant bubble should now be present
    const assistantBubbles = page.getByTestId('message-bubble-assistant');
    await expect(assistantBubbles.first()).toBeVisible();

    // The response should contain some non-empty text
    const text = await assistantBubbles.first().innerText();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  // ---- 5. Check for tool calls (optional) ----
  test('displays tool call cards when the agent uses tools', async ({ page }) => {
    const chatInput = page.getByTestId('chat-input');

    // Ask something that is likely to trigger a tool call.
    // If the agent has no tools this test will be skipped.
    await chatInput.fill('Use a tool to help answer: what files exist in the current directory?');
    await chatInput.press('Enter');

    // Wait for a response
    await expect(page.getByTestId('run-finished')).toBeAttached({
      timeout: RESPONSE_TIMEOUT,
    });

    // Tool call cards are optional — skip assertion if none appear.
    const toolCards = page.getByTestId('tool-call-card');
    const count = await toolCards.count();

    if (count > 0) {
      // At least one card is visible with a tool name
      await expect(toolCards.first()).toBeVisible();
      const toolName = page.getByTestId('tool-call-name').first();
      await expect(toolName).toBeVisible();
      const nameText = await toolName.innerText();
      expect(nameText.trim().length).toBeGreaterThan(0);
    } else {
      // No tool calls — that's OK, just ensure assistant responded
      const assistantBubbles = page.getByTestId('message-bubble-assistant');
      await expect(assistantBubbles.first()).toBeVisible();
    }
  });

  // ---- Keyboard shortcut: Enter to send ----
  test('submits message on Enter key press', async ({ page }) => {
    const chatInput = page.getByTestId('chat-input');

    await chatInput.fill('Ping');
    await chatInput.press('Enter');

    // User bubble should appear (message was sent)
    const userBubble = page.getByTestId('message-bubble-user');
    await expect(userBubble.first()).toBeVisible({ timeout: 5_000 });
    await expect(userBubble.first()).toContainText('Ping');

    // Input should be cleared after send
    await expect(chatInput).toHaveValue('');
  });

  // ---- Shift+Enter inserts newline instead of sending ----
  test('does not send on Shift+Enter (inserts newline)', async ({ page }) => {
    const chatInput = page.getByTestId('chat-input');

    await chatInput.fill('line one');
    await chatInput.press('Shift+Enter');
    await chatInput.type('line two');

    // Message should NOT have been sent — no user bubble yet
    const userBubbles = page.getByTestId('message-bubble-user');
    expect(await userBubbles.count()).toBe(0);

    // Textarea should contain both lines
    const value = await chatInput.inputValue();
    expect(value).toContain('line one');
    expect(value).toContain('line two');
  });

  // ---- Multiple messages in sequence ----
  test('supports multiple messages in a conversation', async ({ page }) => {
    const chatInput = page.getByTestId('chat-input');

    // First message
    await chatInput.fill('What is 2 + 2?');
    await chatInput.press('Enter');

    await expect(page.getByTestId('run-finished')).toBeAttached({
      timeout: RESPONSE_TIMEOUT,
    });

    // Second message
    await chatInput.fill('Now add 3 to that result.');
    await chatInput.press('Enter');

    await expect(page.getByTestId('message-bubble-user')).toHaveCount(2, {
      timeout: 5_000,
    });

    // Wait for second assistant response
    // run-finished re-appears after streaming ends; we wait for at least 2
    // assistant bubbles to confirm the second response arrived.
    await expect(page.getByTestId('message-bubble-assistant').nth(1)).toBeVisible({
      timeout: RESPONSE_TIMEOUT,
    });
  });
});
