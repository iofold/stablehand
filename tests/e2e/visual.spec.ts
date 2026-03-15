import { test, expect } from '@playwright/test';

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
 *   3. Chat (empty) – /agents/:id/chat
 */

const API = 'http://localhost:3001';

test.describe('Visual regression', () => {
  test('dashboard page', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for agent cards to render
    await expect(page.getByTestId('agent-card').first()).toBeVisible({ timeout: 10_000 });

    await expect(page).toHaveScreenshot('dashboard.png', { maxDiffPixelRatio: 0.1 });
  });

  test('agent detail page', async ({ page }) => {
    // Fetch agent ID from API
    const res = await page.request.get(`${API}/api/agents`);
    const agents = await res.json();
    const agentId = agents[0].id;

    await page.goto(`/agents/${agentId}`);
    await page.waitForLoadState('networkidle');

    // Wait for the agent name heading to render
    await expect(page.getByTestId('agent-name')).toBeVisible({ timeout: 10_000 });

    await expect(page).toHaveScreenshot('agent-detail.png', { maxDiffPixelRatio: 0.1 });
  });

  test('chat page empty state', async ({ page }) => {
    const res = await page.request.get(`${API}/api/agents`);
    const agents = await res.json();
    const agentId = agents[0].id;

    await page.goto(`/agents/${agentId}/chat`);
    await page.waitForLoadState('domcontentloaded');

    // Chat page should show the input area
    await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 10_000 });

    await expect(page).toHaveScreenshot('chat-empty.png', { maxDiffPixelRatio: 0.1 });
  });
});
