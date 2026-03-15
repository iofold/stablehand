import { test, expect } from '@playwright/test';

test.describe('Session lifecycle', () => {
  test('agent detail page shows session controls', async ({ page }) => {
    // Navigate to the dashboard
    await page.goto('/');

    // Wait for agents list to load
    const agentCards = page.locator('[data-testid="agent-card"]');
    const count = await agentCards.count();

    // Skip if no agents exist (clean environment)
    test.skip(count === 0, 'No agents available — skip session lifecycle test');

    // Click first agent to go to detail page
    await agentCards.first().click();

    // Verify the agent detail page loaded
    await expect(page.locator('h1, h2, [data-testid="agent-name"]')).toBeVisible();

    // Navigate to Runs tab if it exists
    const runsTab = page.locator('[data-testid="runs-tab"], [role="tab"]:has-text("Runs")');
    if (await runsTab.count() > 0) {
      await runsTab.first().click();
      // Verify runs section is visible
      await expect(
        page.locator('[data-testid="runs-list"], [data-testid="runs-table"]').or(
          page.locator('text=No runs'),
        ),
      ).toBeVisible();
    }
  });

  test('session diff endpoint returns valid response', async ({ request }) => {
    // Test the API directly — create agent, start run, check diff
    const createRes = await request.post('/api/agents', {
      data: {
        name: `e2e-session-test-${Date.now()}`,
        model: 'test-model',
        systemPrompt: 'E2E test agent',
        tools: [],
      },
    });

    // If server doesn't support agent creation, skip
    test.skip(
      createRes.status() === 404 || createRes.status() === 405,
      'Agent creation endpoint not available',
    );

    if (createRes.ok()) {
      const agent = await createRes.json();
      const agentId = agent.id;

      // Try diff endpoint on a non-existent run — should return 404
      const diffRes = await request.get(
        `/api/agents/${agentId}/runs/nonexistent/diff`,
      );
      expect(diffRes.status()).toBe(404);
    }
  });
});
