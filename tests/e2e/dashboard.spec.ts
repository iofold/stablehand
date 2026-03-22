import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent } from './support';

test.describe('Dashboard', () => {
  let agentId = '';
  let agentName = '';

  test.beforeAll(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `dashboard-agent-${Date.now()}`,
      description: 'Dashboard regression test agent',
    });
    agentId = agent.id;
    agentName = agent.name;
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('renders dashboard with agent cards', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const agentCard = page.getByTestId('agent-card').filter({
      has: page.getByText(agentName, { exact: true }),
    });
    await expect(agentCard).toBeVisible({ timeout: 10_000 });
    await expect(agentCard.getByTestId('agent-name')).toHaveText(agentName);
  });

  test('clicking agent card navigates to agent detail', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const agentCard = page.getByTestId('agent-card').filter({
      has: page.getByText(agentName, { exact: true }),
    });
    await expect(agentCard).toBeVisible({ timeout: 10_000 });
    await agentCard.click();

    await expect(page).toHaveURL(`/agents/${agentId}`);
  });
});
