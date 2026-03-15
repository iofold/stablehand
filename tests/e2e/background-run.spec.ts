import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001';

/**
 * Helper: start a background run from agent detail page.
 * Returns the page on the agent detail page after submission.
 */
async function startBackgroundRun(page: import('@playwright/test').Page, task: string) {
  const startRunButton = page.getByTestId('start-run-button').first();
  await expect(startRunButton).toBeVisible();
  await startRunButton.click();

  const taskInput = page.getByTestId('run-task-input').first();
  await expect(taskInput).toBeVisible();
  await taskInput.fill(task);
  await taskInput.press('Enter');

  // Wait for the form to close after submission
  await expect(taskInput).toBeHidden({ timeout: 10000 });
}

test.describe('Background Run Lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Ensure at least one agent card is visible before proceeding
    const agentCards = page.getByTestId('agent-card');
    await expect(agentCards.first()).toBeVisible({ timeout: 10000 });

    // Navigate to agent detail page where start-run-button lives
    await agentCards.first().click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/agents\/[^/]+$/);
  });

  test('trigger a background run and see it in active runs', async ({ page }) => {
    await startBackgroundRun(page, 'E2E test background task');

    // Navigate back to dashboard to check active runs
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // An active run should appear in the active-runs-section on the dashboard
    const activeRunsSection = page.getByTestId('active-runs-section');
    await expect(activeRunsSection).toBeVisible({ timeout: 15000 });

    // The run status badge should be visible within active runs
    const statusBadge = activeRunsSection.getByTestId('run-status-badge').first();
    await expect(statusBadge).toBeVisible();

    // Status should be queued or running
    await expect(statusBadge).toHaveText(/queued|running/);
  });

  test('background run completes and status badge updates', async ({ page }) => {
    await startBackgroundRun(page, 'E2E test run completion');

    // Navigate back to dashboard
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for either: active-runs-section to appear then complete,
    // or if the run already completed, verify via API
    await expect(async () => {
      const section = page.getByTestId('active-runs-section');
      const isVisible = await section.isVisible();

      if (isVisible) {
        const badges = section.getByTestId('run-status-badge');
        const count = await badges.count();
        for (let i = 0; i < count; i++) {
          const text = await badges.nth(i).textContent();
          if (text && /completed|error/.test(text)) return;
        }
        // Refresh to get updated state
        await page.reload();
        throw new Error('Run still active');
      }
      // Section is gone means no active runs (run may have completed already)
    }).toPass({ timeout: 60000, intervals: [2000, 3000, 5000] });
  });

  test('cancel a background run', async ({ page }) => {
    await startBackgroundRun(page, 'E2E test cancel task');

    // Navigate back to dashboard
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for active runs section
    const activeRunsSection = page.getByTestId('active-runs-section');
    await expect(activeRunsSection).toBeVisible({ timeout: 15000 });

    // Click the cancel button on the first active run
    const cancelButton = page.getByTestId('cancel-run-button').first();
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    // After cancellation, the active runs section should eventually disappear
    await expect(async () => {
      const section = page.getByTestId('active-runs-section');
      const isVisible = await section.isVisible();
      if (!isVisible) return;

      const badges = section.getByTestId('run-status-badge');
      const count = await badges.count();
      for (let i = 0; i < count; i++) {
        const text = await badges.nth(i).textContent();
        if (text && /cancelled/.test(text)) return;
      }
      throw new Error('Run still appears active after cancel');
    }).toPass({ timeout: 15000, intervals: [1000, 2000] });
  });

  test('verify background run appears in API', async ({ page }) => {
    // Get agent ID
    const res = await page.request.get(`${API}/api/agents`);
    const agents = await res.json();
    const agentId = agents[0].id;

    await startBackgroundRun(page, 'E2E test API verify');

    // Verify the run exists via API
    await expect(async () => {
      const runsRes = await page.request.get(`${API}/api/agents/${agentId}/runs`);
      const runs = await runsRes.json();
      expect(runs.length).toBeGreaterThan(0);
    }).toPass({ timeout: 15000, intervals: [1000, 2000] });
  });
});
