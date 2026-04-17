import { test, expect } from '@playwright/test';

import { API_BASE, createTestAgent, deleteTestAgent } from './support';

test.describe('Fresh deploy smoke', () => {
  let agentId = '';
  let agentName = '';

  test.beforeAll(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `fresh-deploy-smoke-${Date.now()}`,
      description: 'Deterministic fresh deploy smoke agent',
    });
    agentId = agent.id;
    agentName = agent.name;
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('API health and agent routes respond after a rebuild', async ({ request }) => {
    const health = await request.get(`${API_BASE}/api/health`);
    expect(health.ok()).toBe(true);
    const healthBody = await health.json() as { status: string };
    expect(healthBody.status).toBe('ok');

    const agents = await request.get(`${API_BASE}/api/agents`);
    expect(agents.ok()).toBe(true);
    const body = await agents.json() as Array<{ id: string; name: string }>;
    expect(body.some((agent) => agent.id === agentId && agent.name === agentName)).toBe(true);
  });

  test('dashboard shows the imported smoke agent', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const agentCard = page.getByTestId('agent-card').filter({
      has: page.getByText(agentName, { exact: true }),
    });

    await expect(agentCard).toBeVisible({ timeout: 15_000 });
    await expect(agentCard.getByTestId('agent-name')).toHaveText(agentName);
  });

  test('agent detail page and files tab render without runtime errors', async ({ page }) => {
    await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });

    await expect(page).toHaveURL(`/agents/${agentId}`);
    await expect(page.getByText(agentName, { exact: true })).toBeVisible();

    const filesTab = page.getByTestId('files-tab');
    await expect(filesTab).toBeVisible();
    await filesTab.click();

    const explorer = page.getByTestId('file-explorer');
    await expect(explorer).toBeVisible();
    await expect(explorer.getByText('README.md')).toBeVisible();
  });
});
