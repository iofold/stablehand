import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent, sendAgentMessage, waitForRunStatus } from './support.js';
import { hasHarnessKey, getHarnessConfig, getVQAPrompt, getToolsForHarness } from './visual-qa/support.js';
import { ScreenshotCapture } from './visual-qa/screenshot-capture.js';

const HARNESS = 'langgraph';

test.describe(`${HARNESS} Live Streaming Visual QA`, () => {
  test.skip(!hasHarnessKey(HARNESS), `Skipping: ${HARNESS} API key not available`);

  let agentId = '';

  test.beforeEach(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `vqa-${HARNESS}-${Date.now()}`,
      harness: HARNESS,
      harnessConfig: getHarnessConfig(HARNESS),
      systemPrompt: getVQAPrompt(HARNESS),
      tools: getToolsForHarness(HARNESS),
      description: `VQA live streaming test — ${HARNESS}`,
    });
    agentId = agent.id;
  });

  test.afterEach(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('captures all AG-UI event transitions during live streaming', async ({ page, request }) => {
    test.setTimeout(180_000);
    const capture = new ScreenshotCapture(page, HARNESS, 'live');

    await page.goto(`/agents/${agentId}/chat`);
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 });
    await capture.captureViewport('empty-state', 'Chat page initial empty state');

    const chatInput = page.getByTestId('chat-input');
    await chatInput.fill('Run the visual QA sequence');
    await expect(page.getByTestId('send-button')).toBeEnabled();

    const sendResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );
    await page.getByTestId('send-button').click();
    const sendResponse = await sendResponsePromise;
    const sendBody = await sendResponse.json() as { runId: string; conversationId: string };

    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({ timeout: 5_000 });
    await capture.captureViewport('user-message', 'User message sent');

    // Wait for run completion via API (reliable, not SSE-dependent)
    await waitForRunStatus(request, agentId, sendBody.runId, ['completed', 'error'], 150_000);

    // Give UI time to process final SSE events after run completes
    await page.waitForTimeout(3_000);
    await capture.captureViewport('post-completion', 'UI state after run completion');

    // Reload to get the fully-rendered history view (most reliable)
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3_000);
    await capture.captureViewport('history-loaded', 'History-loaded view with all content');

    // Capture whatever assistant content is visible
    const assistantBubbles = page.getByTestId('message-bubble-assistant');
    const bubbleCount = await assistantBubbles.count();
    for (let i = 0; i < bubbleCount; i++) {
      await capture.captureComponent(assistantBubbles.nth(i), `assistant-bubble-${i}`, `Assistant message bubble ${i}`);
    }

    const toolCards = page.getByTestId('tool-call-card');
    const toolCount = await toolCards.count();
    for (let i = 0; i < toolCount; i++) {
      await capture.captureComponent(toolCards.nth(i), `tool-call-${i}`, `Tool call card ${i}`);
    }

    await capture.captureViewport('final-state', 'Final state with all messages and tool calls');
    await capture.writeManifest();

    const hasContent = bubbleCount > 0 || toolCount > 0;
    expect(hasContent).toBeTruthy();
  });

  test('captures completed run with markdown content', async ({ page, request }) => {
    test.setTimeout(180_000);
    const capture = new ScreenshotCapture(page, HARNESS, 'live');

    await page.goto(`/agents/${agentId}/chat`);
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 });

    const sendResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );
    await page.getByTestId('chat-input').fill('Run the visual QA sequence');
    await page.getByTestId('send-button').click();
    const sendResponse = await sendResponsePromise;
    const sendBody = await sendResponse.json() as { runId: string; conversationId: string };

    await waitForRunStatus(request, agentId, sendBody.runId, ['completed', 'error'], 150_000);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3_000);

    await capture.captureViewport('markdown-view', 'Page with completed response');

    const assistantBubble = page.getByTestId('message-bubble-assistant').last();
    if (await assistantBubble.isVisible().catch(() => false)) {
      await capture.captureComponent(assistantBubble, 'markdown-content', 'Assistant message with markdown');
    }
    await capture.writeManifest();
  });
});
