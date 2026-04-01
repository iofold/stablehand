import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent } from './support.js';
import { hasHarnessKey } from './visual-qa/support.js';
import { ScreenshotCapture } from './visual-qa/screenshot-capture.js';

test.describe('Error State Rendering Visual QA', () => {
  test.skip(!hasHarnessKey('langgraph'), 'Skipping: OPENAI_API_KEY not available');

  let agentId = '';

  test.afterEach(async ({ request }) => {
    if (agentId) await deleteTestAgent(request, agentId);
  });

  test('renders error for invalid/failing agent configuration', async ({ page, request }) => {
    const capture = new ScreenshotCapture(page, 'error-invalid-config', 'live');

    // Create agent with intentionally bad config to trigger an error
    const agent = await createTestAgent(request, {
      name: `vqa-error-config-${Date.now()}`,
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'nonexistent-model-xyz' },
      systemPrompt: 'You are a test agent.',
      tools: [],
      description: 'VQA error test — bad model config',
    });
    agentId = agent.id;

    await page.goto(`/agents/${agentId}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('session-input').fill('Hello');
    await page.getByTestId('send-button').click();

    // Wait for user message, then wait for error or run-finished
    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({ timeout: 5_000 });

    // Wait for either an error message or run-finished
    await Promise.race([
      page.getByTestId('error-message').waitFor({ timeout: 90_000 }),
      page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 90_000 }),
    ]).catch(() => {});

    // Give UI time to render error state
    await page.waitForLoadState('domcontentloaded');

    await capture.captureViewport('error-config-state', 'Error state from invalid model config');

    // Check for error message component
    const errorMsg = page.getByTestId('error-message');
    const hasError = await errorMsg.isVisible().catch(() => false);
    if (hasError) {
      await capture.captureComponent(errorMsg, 'error-message-component', 'Error message component with icon and details');
    }

    await capture.writeManifest();
  });

  test('renders error for nonexistent agent page', async ({ page, request: _request }) => {
    const capture = new ScreenshotCapture(page, 'error-not-found', 'live');

    // Navigate to a non-existent agent
    await page.goto('/agents/nonexistent-agent-id-12345/sessions/new');
    await page.waitForLoadState('domcontentloaded');

    // Capture whatever error state renders
    await capture.captureViewport('error-not-found', 'Error page for nonexistent agent');

    await capture.writeManifest();
  });

  test('captures run error state in chat', async ({ page, request }) => {
    const capture = new ScreenshotCapture(page, 'error-run-failure', 'live');

    // Create a normal agent but make it fail with a tool error
    const agent = await createTestAgent(request, {
      name: `vqa-error-tool-${Date.now()}`,
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
      systemPrompt: 'You must use the exec-command tool to run: exit 1. This will fail intentionally.',
      tools: ['exec-command'],
      description: 'VQA error test — tool failure',
    });
    agentId = agent.id;

    await page.goto(`/agents/${agentId}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('session-input').fill('Run the command that fails');
    await page.getByTestId('send-button').click();

    // Wait for either error or completion
    await Promise.race([
      page.getByTestId('error-message').waitFor({ timeout: 120_000 }),
      page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 120_000 }),
    ]).catch(() => {});

    await page.waitForLoadState('domcontentloaded');

    await capture.captureViewport('error-run-failure-state', 'Chat after run error/failure');

    // Check for tool call error in card
    const toolCards = page.getByTestId('tool-call-card');
    const toolCount = await toolCards.count();
    for (let i = 0; i < toolCount; i++) {
      await capture.captureComponent(
        toolCards.nth(i),
        `error-tool-card-${i}`,
        'Tool call card showing error state',
      );
    }

    // Check for error message
    const errorMsg = page.getByTestId('error-message');
    if (await errorMsg.isVisible().catch(() => false)) {
      await capture.captureComponent(errorMsg, 'error-message-detail', 'Error message component');
    }

    await capture.writeManifest();
  });
});
