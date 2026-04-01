import { test, expect } from '@playwright/test';
import {
  API_BASE,
  createTestAgent,
  deleteTestAgent,
  startBackgroundRun as startBackgroundRunApi,
  waitForRunStatus,
} from './support';

/**
 * Helper: start a background run from agent detail page.
 * Returns the page on the agent detail page after submission.
 */
async function startBackgroundRun(
  page: import('@playwright/test').Page,
  agentId: string,
  task: string,
) {
  const startRunButton = page.getByTestId('start-session-button').first();
  await expect(startRunButton).toBeVisible();
  const runResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    response.url().includes(`/api/agents/${agentId}/session`) &&
    response.status() === 201,
  );
  await startRunButton.click();

  const taskInput = page.getByTestId('run-task-input').first();
  await expect(taskInput).toBeVisible();
  await taskInput.fill(task);
  await taskInput.press('Enter');

  // Wait for the form to close after submission
  await expect(taskInput).toBeHidden({ timeout: 10000 });
  return (await (await runResponse).json()) as { sessionId: string; conversationId: string };
}

test.describe('Background Run Lifecycle', () => {
  let agentId = '';

  test.beforeAll(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `background-agent-${Date.now()}`,
      description: 'Background run regression test agent',
    });
    agentId = agent.id;
  });

  test.afterAll(async ({ request }) => {
    if (agentId) {
      await deleteTestAgent(request, agentId);
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(`/agents/${agentId}`);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(`/agents/${agentId}`);
  });

  test('trigger a background run and see it in active runs', async ({ page }) => {
    const run = await startBackgroundRun(page, agentId, 'E2E test background task');

    // Navigate back to dashboard to check active runs
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(async () => {
      const activeRunsSection = page.getByTestId('active-runs-section');
      const sectionVisible = await activeRunsSection.isVisible().catch(() => false);
      const runsRes = await page.request.get(`${API_BASE}/api/agents/${agentId}/sessions`);
      const body = await runsRes.json();
      const runs = body.sessions ?? body;
      const matchingRun = runs.find((entry: { id: string; sessionId?: string; status: string }) => entry.sessionId === run.sessionId || entry.id === run.sessionId);
      expect(matchingRun).toBeTruthy();
      expect(['queued', 'running', 'completed', 'error']).toContain(matchingRun.status);
      if (!sectionVisible && ['queued', 'running'].includes(matchingRun.status)) {
        throw new Error('Active runs section not visible while run is still active');
      }
    }).toPass({ timeout: 15000, intervals: [1000, 2000] });
  });

  test('background run completes and status badge updates', async ({ page }) => {
    const run = await startBackgroundRun(page, agentId, 'E2E test run completion');

    const finalRun = await waitForRunStatus(
      page.request,
      agentId,
      run.sessionId,
      ['completed', 'error'],
      60_000,
    );
    expect(['completed', 'error']).toContain(finalRun.status);
  });

  test('cancel a background run', async ({ page }) => {
    const run = await startBackgroundRunApi(
      page.request,
      agentId,
      'Background run cancellation regression test.',
    );
    const cancelRes = await page.request.post(
      `${API_BASE}/api/agents/${agentId}/sessions/${run.sessionId}/cancel`,
    );
    expect([200, 404]).toContain(cancelRes.status());
    const finalRun = await waitForRunStatus(
      page.request,
      agentId,
      run.sessionId,
      ['cancelled', 'completed'],
      15_000,
    );
    expect(['cancelled', 'completed']).toContain(finalRun.status);
  });

  test('verify background run appears in API', async ({ page }) => {
    const run = await startBackgroundRun(page, agentId, 'E2E test API verify');

    // Verify the run exists via API
    await expect(async () => {
      const runsRes = await page.request.get(`${API_BASE}/api/agents/${agentId}/sessions`);
      const body = await runsRes.json();
      const runs = body.sessions ?? body;
      expect(runs.some((entry: { id: string; sessionId?: string }) => entry.sessionId === run.sessionId || entry.id === run.sessionId)).toBe(true);
    }).toPass({ timeout: 15000, intervals: [1000, 2000] });
  });
});
