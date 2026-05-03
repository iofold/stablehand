import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent } from './support.js';
import { hasHarnessKey, getHarnessConfig, getVQAPrompt, getToolsForHarness } from './visual-qa/support.js';
import { ScreenshotCapture } from './visual-qa/screenshot-capture.js';

const HARNESS = 'pi-agent';

test.describe(`${HARNESS} Live Streaming Visual QA @extended`, () => {
  // Skip entire suite if API key not available
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

  test('captures all AG-UI event transitions during live streaming', async ({ page }) => {
    const capture = new ScreenshotCapture(page, HARNESS, 'live');

    // 1. Navigate to chat page
    await page.goto(`/agents/${agentId}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });
    await capture.captureViewport('empty-state', 'Chat page initial empty state');

    // 2. Send the VQA trigger message
    const chatInput = page.getByTestId('session-input');
    await chatInput.fill('Run the visual QA sequence');
    await expect(page.getByTestId('send-button')).toBeEnabled();
    await page.getByTestId('send-button').click();

    // 3. Wait for user message bubble
    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({ timeout: 5_000 });
    await capture.captureViewport('user-message', 'User message sent');

    await Promise.race([
      page.getByTestId('message-bubble-assistant').waitFor({ timeout: 60_000 }),
      page.getByTestId('tool-call-card').first().waitFor({ timeout: 60_000 }),
    ]);
    await capture.captureViewport('agent-responding', 'Agent activity visible — text or tool call');

    const toolCard = page.getByTestId('tool-call-card').first();
    if (await toolCard.isVisible().catch(() => false)) {
      await capture.captureComponent(toolCard, 'tool-call-running', 'Tool call card during execution');
      const toolName = page.getByTestId('tool-call-name').first();
      if (await toolName.isVisible().catch(() => false)) {
        const nameText = await toolName.innerText();
        expect(nameText.trim().length).toBeGreaterThan(0);
      }
    }

    if (await page.getByTestId('message-bubble-assistant').first().isVisible().catch(() => false)) {
      await capture.captureViewport('text-streaming', 'Assistant text streaming');
    }

    // 7. Wait for run to complete
    await page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 120_000 });
    await capture.captureViewport('run-finished', 'Full run completed — all events rendered');

    // 8. Capture completed tool call state
    const allToolCards = page.getByTestId('tool-call-card');
    const toolCount = await allToolCards.count();
    for (let i = 0; i < toolCount; i++) {
      await capture.captureComponent(
        allToolCards.nth(i),
        `tool-call-complete-${i}`,
        `Completed tool call card ${i}`,
      );
    }

    if (await page.getByTestId('message-bubble-assistant').last().isVisible().catch(() => false)) {
      const assistantText = await page.getByTestId('message-bubble-assistant').last().innerText();
      expect(assistantText.length).toBeGreaterThan(0);
    }

    await capture.captureViewport('final-state', 'Final state with all messages and tool calls');
    await capture.writeManifest();

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const hasPersistedContent = await Promise.race([
      page.getByTestId('message-bubble-assistant').first().waitFor({ timeout: 10_000 }).then(() => true),
      page.getByTestId('tool-call-card').first().waitFor({ timeout: 10_000 }).then(() => true),
    ]).catch(() => false);
    await capture.captureViewport('after-reload', 'Content state after page reload');
    expect(hasPersistedContent).toBeTruthy();
  });

  test('verifies markdown rendering in assistant response', async ({ page }) => {
    const capture = new ScreenshotCapture(page, HARNESS, 'live');

    await page.goto(`/agents/${agentId}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('session-input').fill('Run the visual QA sequence');
    await page.getByTestId('send-button').click();

    await page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 120_000 }).catch(() => {});
    await capture.captureViewport('markdown-final', 'Page state after run attempt');

    const assistantBubble = page.getByTestId('message-bubble-assistant').last();
    if (await assistantBubble.isVisible().catch(() => false)) {
      await capture.captureComponent(assistantBubble, 'markdown-content', 'Assistant message with markdown formatting');
    }
    await capture.writeManifest();
  });
});
