import { test, expect } from '@playwright/test';

/**
 * E2E-01: Five-Minute Journey
 *
 * Full Day One acceptance test covering the complete user flow:
 *   Dashboard -> Pick agent -> Chat -> Tool calls -> Feedback -> Agent detail -> Knowledge
 *
 * Wall-clock budget: 120 seconds.
 *
 * data-testid map:
 *   agent-card                 - dashboard agent card         (Dashboard)
 *   agent-name                 - agent name text              (Dashboard / AgentDetailPage)
 *   chat-input                 - textarea for message input   (ChatInput)
 *   send-button                - submit button                (ChatInput)
 *   message-bubble-user        - user message bubble          (MessageBubble)
 *   message-bubble-assistant   - assistant message bubble     (MessageBubble)
 *   tool-call-card             - tool execution card          (ToolCallCard)
 *   tool-call-name             - tool name display            (ToolCallCard)
 *   run-finished               - hidden marker on stream end  (ChatPage)
 *   feedback-buttons           - feedback button group        (FeedbackButtons)
 *   thumbs-up                  - thumbs up button             (FeedbackButtons)
 *   thumbs-down                - thumbs down button           (FeedbackButtons)
 *   back-button                - back navigation              (AgentDetailPage)
 *   learning-dashboard         - learning dashboard section   (AgentDetailPage)
 *   knowledge-tab              - knowledge tab button         (AgentDetailPage)
 *   knowledge-explorer         - knowledge explorer section   (AgentDetailPage)
 *   knowledge-growth           - knowledge growth card        (AgentDetailPage)
 *   trace-stats                - trace stats card             (AgentDetailPage)
 *   feedback-summary           - feedback summary card        (AgentDetailPage)
 */

/** Timeout for waiting on an LLM assistant response. */
const RESPONSE_TIMEOUT = 60_000;

test.describe('Five-Minute Journey (E2E-01)', () => {
  test('complete user flow: dashboard -> chat -> feedback -> knowledge', async ({ page }) => {
    test.setTimeout(120_000);
    const start = Date.now();

    // ---------------------------------------------------------------
    // 1. Dashboard — navigate to root and see agent cards
    // ---------------------------------------------------------------
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const firstCard = page.getByTestId('agent-card').first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });

    // Verify the card has a visible agent name
    const agentName = page.getByTestId('agent-name').first();
    await expect(agentName).toBeVisible();
    await expect(agentName).not.toBeEmpty();

    // ---------------------------------------------------------------
    // 2. Pick agent — click first agent card, navigate to detail then chat
    // ---------------------------------------------------------------
    await firstCard.click();
    await expect(page).toHaveURL(/\/agents\/[^/]+$/);

    // Navigate to chat from agent detail page
    const chatUrl = page.url() + '/chat';
    await page.goto(chatUrl);

    // ---------------------------------------------------------------
    // 3. Chat — type message, submit, see user bubble
    // ---------------------------------------------------------------
    const chatInput = page.getByTestId('chat-input');
    await expect(chatInput).toBeVisible({ timeout: 15_000 });

    const sendButton = page.getByTestId('send-button');
    await expect(sendButton).toBeVisible();

    const userMessage = 'Show me a summary of revenue trends';
    await chatInput.fill(userMessage);
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // User bubble should appear (use last() since prior conversations may exist)
    const userBubble = page.getByTestId('message-bubble-user').last();
    await expect(userBubble).toBeVisible({ timeout: 5_000 });
    await expect(userBubble).toContainText(userMessage);

    // ---------------------------------------------------------------
    // 4. Wait for assistant response (and optional tool calls)
    // ---------------------------------------------------------------
    await expect(page.getByTestId('run-finished')).toBeAttached({
      timeout: RESPONSE_TIMEOUT,
    });

    const assistantBubble = page.getByTestId('message-bubble-assistant').last();
    await expect(assistantBubble).toBeVisible();

    // The response should contain non-empty text
    const responseText = await assistantBubble.innerText();
    expect(responseText.trim().length).toBeGreaterThan(0);

    // Tool call cards are optional — verify if present
    const toolCards = page.getByTestId('tool-call-card');
    const toolCardCount = await toolCards.count();
    if (toolCardCount > 0) {
      await expect(toolCards.first()).toBeVisible();
      const toolName = page.getByTestId('tool-call-name').first();
      await expect(toolName).toBeVisible();
      const toolNameText = await toolName.innerText();
      expect(toolNameText.trim().length).toBeGreaterThan(0);
    }

    // ---------------------------------------------------------------
    // 5. Feedback — click thumbs up on assistant message
    // ---------------------------------------------------------------
    const feedbackGroup = page.getByTestId('feedback-buttons').first();
    if (await feedbackGroup.isVisible()) {
      const thumbsUpBtn = page.getByTestId('thumbs-up').first();
      await expect(thumbsUpBtn).toBeVisible();
      await thumbsUpBtn.click();

      // After clicking, the button should become disabled (feedback submitted)
      await expect(thumbsUpBtn).toBeDisabled({ timeout: 5_000 });
    }

    // ---------------------------------------------------------------
    // 6. Agent detail — navigate to agent overview page
    // ---------------------------------------------------------------
    // Extract agent ID from current chat URL
    const currentUrl = page.url();
    const agentIdMatch = currentUrl.match(/\/agents\/([^/]+)/);
    expect(agentIdMatch).not.toBeNull();
    const agentId = agentIdMatch![1];

    await page.goto(`/agents/${agentId}`);
    await page.waitForLoadState('networkidle');

    // The learning dashboard should be visible on the overview tab
    const learningDashboard = page.getByTestId('learning-dashboard');
    await expect(learningDashboard).toBeVisible({ timeout: 10_000 });

    // Verify sub-sections of the learning dashboard are present
    await expect(page.getByTestId('knowledge-growth')).toBeVisible();
    await expect(page.getByTestId('trace-stats')).toBeVisible();
    await expect(page.getByTestId('feedback-summary')).toBeVisible();

    // ---------------------------------------------------------------
    // 7. Knowledge tab — switch to knowledge and verify explorer
    // ---------------------------------------------------------------
    const knowledgeTab = page.getByTestId('knowledge-tab');
    await expect(knowledgeTab).toBeVisible();
    await knowledgeTab.click();

    const knowledgeExplorer = page.getByTestId('knowledge-explorer');
    await expect(knowledgeExplorer).toBeVisible({ timeout: 10_000 });

    // ---------------------------------------------------------------
    // Wall-clock timing assertion
    // ---------------------------------------------------------------
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(120_000);
  });
});
