import { test, expect } from '@playwright/test';
import {
  createTestAgent,
  deleteTestAgent,
  startBackgroundRun,
  waitForRunStatus,
} from './support';

test.describe('Session lifecycle', () => {
  let agentId = '';
  let sessionId = '';

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
    sessionId = run.sessionId;
    await waitForRunStatus(request, agentId, sessionId, ['completed', 'error']);
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test('agent detail page shows session controls', async ({ page }) => {
    await page.goto(`/agents/${agentId}`);
    await expect(page.getByTestId('agent-name')).toBeVisible();

    await page.getByTestId('sessions-tab').click();
    const runsHistory = page.getByTestId('sessions-history');
    await expect(runsHistory).toBeVisible();

    const runRows = runsHistory.locator('tbody tr');
    await expect(runRows.first()).toBeVisible();
    await runRows.first().click();

    await expect(page.getByRole('button', { name: 'Continue Conversation' })).toBeVisible();
    await expect(page.getByTestId('session-detail').getByText('Turns')).toBeVisible();
    await expect(page.getByText('Generate a short report and finish cleanly for session UI testing.')).toBeVisible();
  });

  test('session detail endpoint returns valid response', async ({ request }) => {
    const detailRes = await request.get(`/api/agents/${agentId}/sessions/${sessionId}`);
    expect(detailRes.ok()).toBeTruthy();
    const body = await detailRes.json();
    expect(body.session).toHaveProperty('id', sessionId);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});
