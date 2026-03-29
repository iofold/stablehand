import { test, expect } from '@playwright/test';
import {
  createTestAgent,
  deleteTestAgent,
  getInterrupts,
  resolveInterrupt,
} from './support.js';
import { hasHarnessKey } from './visual-qa/support.js';
import { ScreenshotCapture } from './visual-qa/screenshot-capture.js';

test.describe('HITL Approval Flow Visual QA', () => {
  test.skip(!hasHarnessKey('langgraph'), 'Skipping: OPENAI_API_KEY not available');

  let agentId = '';

  test.beforeEach(async ({ request }) => {
    // Create an agent with the execute-trade tool (requires approval)
    const agent = await createTestAgent(request, {
      name: `vqa-hitl-${Date.now()}`,
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
      systemPrompt: 'When asked to execute a trade, use the execute-trade tool to buy 10 shares of AAPL at market price. Always use the execute-trade tool.',
      tools: ['execute-trade', 'emit-event'],
      description: 'VQA HITL approval test agent',
    });
    agentId = agent.id;
  });

  test.afterEach(async ({ request }) => {
    if (agentId) await deleteTestAgent(request, agentId);
  });

  test('captures approval card pending and approved states', async ({ page, request }) => {
    const capture = new ScreenshotCapture(page, 'hitl', 'live');

    await page.goto(`/agents/${agentId}/chat`);
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 });
    await capture.captureViewport('hitl-empty', 'Chat page before HITL trigger');

    // Send message that triggers HITL approval
    await page.getByTestId('chat-input').fill('Execute a trade to buy AAPL shares');
    await page.getByTestId('send-button').click();
    await expect(page.getByTestId('message-bubble-user').last()).toBeVisible({ timeout: 5_000 });

    // Wait for approval card to appear
    const approvalCard = page.getByTestId('approval-card');
    await expect(approvalCard).toBeVisible({ timeout: 90_000 });
    await capture.captureViewport('hitl-pending-viewport', 'HITL approval card visible in chat');
    await capture.captureComponent(approvalCard, 'hitl-pending-card', 'Approval card — pending state with approve/reject buttons');

    // Verify approve and reject buttons exist
    const approveBtn = page.getByTestId('approve-button');
    const rejectBtn = page.getByTestId('reject-button');
    await expect(approveBtn).toBeVisible();
    await expect(rejectBtn).toBeVisible();

    // Click approve
    await approveBtn.click();

    // Wait for resolution indicator
    const resolvedIndicator = page.getByTestId('approval-approved');
    const resolved = await resolvedIndicator.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);

    // Capture resolved state
    await capture.captureViewport('hitl-approved-viewport', 'After approval — resolved state');
    if (await approvalCard.isVisible().catch(() => false)) {
      await capture.captureComponent(approvalCard, 'hitl-approved-card', 'Approval card — approved state');
    }

    // Wait for run to finish after approval
    await page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 90_000 }).catch(() => {});
    await capture.captureViewport('hitl-finished', 'Run completed after HITL approval');

    await capture.writeManifest();
  });

  test('captures rejection flow', async ({ page, request }) => {
    const capture = new ScreenshotCapture(page, 'hitl-reject', 'live');

    await page.goto(`/agents/${agentId}/chat`);
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('chat-input').fill('Execute a trade to buy AAPL shares');
    await page.getByTestId('send-button').click();

    // Wait for approval card
    const approvalCard = page.getByTestId('approval-card');
    await expect(approvalCard).toBeVisible({ timeout: 90_000 });
    await capture.captureViewport('hitl-reject-pending', 'Approval card before rejection');

    // Click reject
    await page.getByTestId('reject-button').click();

    // Brief wait for UI to update rejection status
    await page.waitForTimeout(2000);
    await capture.captureViewport('hitl-rejected-viewport', 'After rejection');
    if (await approvalCard.isVisible().catch(() => false)) {
      await capture.captureComponent(approvalCard, 'hitl-rejected-card', 'Approval card — rejected state');
    }

    await capture.writeManifest();
  });
});
