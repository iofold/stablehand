import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent } from './support';

/**
 * Visual regression tests for core pages.
 *
 * Uses Playwright's `toHaveScreenshot()` for pixel-level comparison against
 * committed baseline PNGs. On first run (no baselines), Playwright generates
 * the reference images automatically.
 *
 * Pages covered:
 *   1. Dashboard   – /
 *   2. Agent detail – /agents/:id
 *   3. Chat (empty) – /agents/:id/conversations/new
 */

test.describe('Visual regression @extended', () => {
  let agentId = '';
  const agentName = 'visual-agent-regression';

  test.beforeAll(async ({ request }) => {
    const existingAgentsRes = await request.get('/api/agents');
    expect(existingAgentsRes.ok()).toBeTruthy();
    const existingAgents = await existingAgentsRes.json();
    for (const existing of existingAgents as Array<{ id: string; name: string }>) {
      if (existing.name === agentName) {
        await deleteTestAgent(request, existing.id);
      }
    }

    const agent = await createTestAgent(request, {
      name: agentName,
      description: 'Visual regression test agent',
    });
    agentId = agent.id;
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('dashboard page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const agentCard = page.getByTestId('agent-card').filter({
      has: page.getByText(agentName, { exact: true }),
    });
    await expect(agentCard).toBeVisible({ timeout: 10_000 });

    await expect(agentCard).toHaveScreenshot('dashboard-agent-card.png', { maxDiffPixelRatio: 0.1 });
  });

  test('agent detail page', async ({ page }) => {
    await page.goto(`/agents/${agentId}`);
    await page.waitForLoadState('networkidle');

    // Wait for the agent name heading to render
    await expect(page.getByTestId('agent-name')).toBeVisible({ timeout: 10_000 });

    const detailHeader = page.locator('header').first();
    await expect(detailHeader).toHaveScreenshot('agent-detail-header.png', { maxDiffPixelRatio: 0.1 });
  });

  test('chat page empty state', async ({ page }) => {
    await page.goto(`/agents/${agentId}/sessions/new`);
    await page.waitForLoadState('domcontentloaded');

    // Chat page should show the input area
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 10_000 });

    const chatComposer = page.getByTestId('session-input').locator('xpath=..');
    await expect(chatComposer).toHaveScreenshot('chat-empty-composer.png', { maxDiffPixelRatio: 0.1 });
  });
});
