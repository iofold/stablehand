import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('renders dashboard with agent cards', async ({ page }) => {
    await page.goto('/');

    // Wait for the page to load
    await page.waitForLoadState('networkidle');

    // Should have at least one agent card
    const agentCards = page.getByTestId('agent-card');
    await expect(agentCards.first()).toBeVisible({ timeout: 10000 });

    // Should show agent name
    const agentName = page.getByTestId('agent-name').first();
    await expect(agentName).toBeVisible();
    await expect(agentName).not.toBeEmpty();
  });

  test('clicking agent card navigates to chat', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const firstCard = page.getByTestId('agent-card').first();
    await expect(firstCard).toBeVisible({ timeout: 10000 });

    await firstCard.click();

    // Agent card navigates to /agents/:id/chat
    await expect(page).toHaveURL(/\/agents\/[^/]+\/chat/);
  });
});
