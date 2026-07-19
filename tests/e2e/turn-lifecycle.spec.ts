import { test, expect } from '@playwright/test';
import {
  createTestAgent,
  deleteTestAgent,
  startBackgroundRun,
  waitForRunStatus,
} from './support';

test.describe('Turn lifecycle @extended', () => {
  let agentId = '';
  let turnId = '';

  test.beforeAll(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `turn-agent-${Date.now()}`,
      description: 'Turn lifecycle regression test agent',
    });
    agentId = agent.id;

    const run = await startBackgroundRun(
      request,
      agentId,
      'Generate a short report and finish cleanly for turn UI testing.',
    );
    turnId = run.turnId;
    await waitForRunStatus(request, agentId, turnId, ['completed', 'error']);
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('agent detail page shows turn controls', async ({ page }) => {
    await page.goto(`/agents/${agentId}`);
    await expect(page.getByTestId('agent-name')).toBeVisible();

    await page.getByTestId('turns-tab').click();
    const runsHistory = page.getByTestId('turns-history');
    await expect(runsHistory).toBeVisible();

    const runRows = runsHistory.locator('tbody tr');
    await expect(runRows.first()).toBeVisible();
    await runRows.first().click();

    await expect(page.getByRole('button', { name: 'Continue Conversation' })).toBeVisible();
    await expect(page.getByText('Generate a short report and finish cleanly for turn UI testing.')).toBeVisible();
  });

  test('turn detail endpoint returns valid response', async ({ request }) => {
    const detailRes = await request.get(`/api/agents/${agentId}/turns/${turnId}`);
    expect(detailRes.ok()).toBeTruthy();
    const body = await detailRes.json();
    expect(body.turn).toHaveProperty('id', turnId);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});
