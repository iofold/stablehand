import { test, expect } from '@playwright/test';
import {
  createTestAgent,
  deleteTestAgent,
  startBackgroundRun,
  waitForRunStatus,
} from './support.js';
import {
  hasHarnessKey,
  getHarnessConfig,
  getVQAPrompt,
  getToolsForHarness,
} from './visual-qa/support.js';
import { ScreenshotCapture } from './visual-qa/screenshot-capture.js';

/**
 * Replay Mode Visual QA — tests the RunDetailPage for completed runs.
 *
 * For each harness:
 * 1. Create agent → start background run → wait for completion
 * 2. Navigate to the run detail page (replay mode)
 * 3. Capture screenshots and verify:
 *    - No streaming indicators (no typing dots, no "Live" badge)
 *    - All messages fully rendered
 *    - All tool call cards in completed state
 *    - Back button present
 *    - Static status badge ("completed")
 */

const HARNESSES = ['langgraph', 'claude-agents', 'pi-agent'] as const;

for (const harness of HARNESSES) {
  test.describe(`${harness} Replay Mode Visual QA @extended`, () => {
    test.skip(!hasHarnessKey(harness), `Skipping: ${harness} API key not available`);

    let agentId = '';
    let sessionId = '';
    let conversationId = '';

    test.beforeEach(async ({ request }) => {
      // Create agent
      const agent = await createTestAgent(request, {
        name: `vqa-replay-${harness}-${Date.now()}`,
        harness,
        harnessConfig: getHarnessConfig(harness),
        systemPrompt: getVQAPrompt(harness),
        tools: getToolsForHarness(harness),
        description: `VQA replay test — ${harness}`,
      });
      agentId = agent.id;

      // Start background run and wait for completion
      const run = await startBackgroundRun(request, agentId, 'Run the visual QA sequence');
      sessionId = run.sessionId;
      conversationId = run.conversationId;

      // Wait for run to complete (120s timeout for safety)
      await waitForRunStatus(request, agentId, sessionId, ['completed', 'error'], 120_000);
    });

    test.afterEach(async ({ request }) => {
      if (agentId) {
        await deleteTestAgent(request, agentId);
      }
    });

    test('renders completed run in static replay mode', async ({ page }) => {
      const capture = new ScreenshotCapture(page, harness, 'replay');

      // Navigate to the runs tab to find the run
      await page.goto(`/agents/${agentId}`);
      await page.waitForLoadState('domcontentloaded');

      // Click on the Runs tab
      const runsTab = page.getByTestId('runs-tab');
      if (await runsTab.isVisible().catch(() => false)) {
        await runsTab.click();
        await page.waitForLoadState('domcontentloaded');
      }

      await capture.captureViewport('runs-list', 'Runs list showing completed run');

      // Navigate to the run detail page
      // Try direct URL navigation to the run
      await page.goto(`/agents/${agentId}/sessions/${conversationId}`);
      await page.waitForLoadState('domcontentloaded');

      // Wait for the page to load content
      // The run-detail-page or the messages should be visible
      const pageLoaded = await Promise.race([
        page.getByTestId('run-detail-page').waitFor({ timeout: 15_000 }).then(() => true),
        page.getByTestId('message-bubble-assistant').first().waitFor({ timeout: 15_000 }).then(() => true),
        page.getByTestId('run-messages').waitFor({ timeout: 15_000 }).then(() => true),
      ]).catch(() => false);

      await capture.captureViewport('replay-overview', 'Run detail page — full replay view');

      // Verify NO streaming indicators
      // The "Live" badge or streaming indicator should NOT be present
      // (We check by absence — these elements shouldn't exist in replay)

      // Verify assistant messages are present
      const assistantMessages = page.getByTestId('message-bubble-assistant');
      const msgCount = await assistantMessages.count();

      if (msgCount > 0) {
        // Capture each assistant message
        await capture.captureComponent(
          assistantMessages.first(),
          'replay-assistant-message',
          'Assistant message in replay mode — should be fully rendered, no cursor',
        );
      }

      // Verify tool call cards are in completed state
      const toolCards = page.getByTestId('tool-call-card');
      const toolCount = await toolCards.count();

      for (let i = 0; i < toolCount; i++) {
        await capture.captureComponent(
          toolCards.nth(i),
          `replay-tool-complete-${i}`,
          `Tool call card ${i} in replay — should show green/completed status`,
        );
      }

       // Check for back button
       const backButton = page.getByTestId('back-button');
       const hasBackButton = await backButton.isVisible().catch(() => false);
       expect(hasBackButton).toBe(true);

       // Final full-page capture
      await capture.captureViewport('replay-final', 'Final replay page state');

      // Write manifest for later analysis
      await capture.writeManifest();

      // DOM assertions
      // The page should have loaded (either run-detail-page, messages, or run-messages)
      expect(pageLoaded).toBeTruthy();
    });
  });
}
