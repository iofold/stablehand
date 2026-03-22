import { test, expect } from '@playwright/test';
import {
  createTestAgent,
  deleteTestAgent,
  startBackgroundRun,
  waitForRunStatus,
} from './support';

test.describe('Session lifecycle', () => {
  let agentId = '';
  let runId = '';

  test.beforeAll(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `session-agent-${Date.now()}`,
      description: 'Session lifecycle regression test agent',
    });
    agentId = agent.id;

    const run = await startBackgroundRun(
      request,
      agentId,
      'Generate a short report and finish cleanly for session UI testing.',
    );
    runId = run.runId;
    await waitForRunStatus(request, agentId, runId, ['completed', 'error']);
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('agent detail page shows session controls', async ({ page }) => {
    await page.goto(`/agents/${agentId}`);
    await expect(page.getByTestId('agent-name')).toBeVisible();

    await page.getByTestId('runs-tab').click();
    const runsHistory = page.getByTestId('runs-history');
    await expect(runsHistory).toBeVisible();

    const runRow = runsHistory.locator('tbody tr').filter({
      has: page.getByText(runId.slice(0, 8), { exact: true }),
    });
    await expect(runRow.first()).toBeVisible();
    await runRow.first().click();

    await expect(page.getByTestId('run-detail')).toBeVisible();
    await expect(page.getByText('Session workspace')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Browse Files' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'View Diff' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Promote' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fork' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();
  });

  test('session diff endpoint returns valid response', async ({ request }) => {
    const diffRes = await request.get(`/api/agents/${agentId}/runs/${runId}/diff`);
    expect(diffRes.ok()).toBeTruthy();
    const body = await diffRes.json();
    expect(body).toHaveProperty('changes');
    expect(Array.isArray(body.changes)).toBe(true);
  });
});
