import { test, expect } from '@playwright/test';

test.describe('Background Run Lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Ensure at least one agent card is visible before proceeding
    const agentCards = page.getByTestId('agent-card');
    await expect(agentCards.first()).toBeVisible({ timeout: 10000 });
  });

  test('trigger a background run and see it in active runs', async ({ page }) => {
    // Step 1: Click the start-run-button to reveal the inline run form
    const startRunButton = page.getByTestId('start-run-button').first();
    await expect(startRunButton).toBeVisible();
    await startRunButton.click();

    // Step 2: Fill in the task description
    const taskInput = page.getByTestId('run-task-input').first();
    await expect(taskInput).toBeVisible();
    await taskInput.fill('E2E test background task');

    // Step 3: Submit the form to start the run
    await taskInput.press('Enter');

    // Step 4: The run form should close after submission
    await expect(taskInput).toBeHidden({ timeout: 10000 });

    // Step 5: An active run should appear in the active-runs-section on the dashboard
    const activeRunsSection = page.getByTestId('active-runs-section');
    await expect(activeRunsSection).toBeVisible({ timeout: 15000 });

    // The run status badge should be visible within active runs
    const statusBadge = activeRunsSection.getByTestId('run-status-badge').first();
    await expect(statusBadge).toBeVisible();

    // Status should be queued or running
    await expect(statusBadge).toHaveText(/queued|running/);
  });

  test('background run completes and status badge updates', async ({ page }) => {
    // Trigger a background run
    const startRunButton = page.getByTestId('start-run-button').first();
    await startRunButton.click();

    const taskInput = page.getByTestId('run-task-input').first();
    await expect(taskInput).toBeVisible();
    await taskInput.fill('E2E test run completion');
    await taskInput.press('Enter');

    // Wait for active runs section to appear
    const activeRunsSection = page.getByTestId('active-runs-section');
    await expect(activeRunsSection).toBeVisible({ timeout: 15000 });

    // Wait for the run to finish: the status badge should show completed or error
    // (the active-runs-section only shows running/queued runs, so it may disappear
    // once the run completes; alternatively the badge text updates)
    //
    // Strategy: wait for either the status to change to completed/error,
    // or for the active-runs-section to disappear (meaning no more active runs).
    await expect(async () => {
      const section = page.getByTestId('active-runs-section');
      const isVisible = await section.isVisible();

      if (isVisible) {
        // Check if any badge shows a terminal status
        const badges = section.getByTestId('run-status-badge');
        const count = await badges.count();
        for (let i = 0; i < count; i++) {
          const text = await badges.nth(i).textContent();
          if (text && /completed|error/.test(text)) return;
        }
        throw new Error('Run still active');
      }
      // Section is gone means run finished and was removed from active list
    }).toPass({ timeout: 60000, intervals: [1000, 2000, 3000] });
  });

  test('cancel a background run', async ({ page }) => {
    // Trigger a background run
    const startRunButton = page.getByTestId('start-run-button').first();
    await startRunButton.click();

    const taskInput = page.getByTestId('run-task-input').first();
    await expect(taskInput).toBeVisible();
    await taskInput.fill('E2E test cancel task');
    await taskInput.press('Enter');

    // Wait for active runs section
    const activeRunsSection = page.getByTestId('active-runs-section');
    await expect(activeRunsSection).toBeVisible({ timeout: 15000 });

    // Click the cancel button on the first active run
    const cancelButton = page.getByTestId('cancel-run-button').first();
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();

    // After cancellation, the active runs section should eventually disappear
    // (or the run count decreases)
    await expect(async () => {
      const section = page.getByTestId('active-runs-section');
      const isVisible = await section.isVisible();
      if (!isVisible) return; // section gone, run was removed

      // Or check that the cancelled run's badge reflects the new status
      const badges = section.getByTestId('run-status-badge');
      const count = await badges.count();
      for (let i = 0; i < count; i++) {
        const text = await badges.nth(i).textContent();
        if (text && /cancelled/.test(text)) return;
      }
      throw new Error('Run still appears active after cancel');
    }).toPass({ timeout: 15000, intervals: [1000, 2000] });
  });

  test('clicking an active run navigates to run detail page', async ({ page }) => {
    // Trigger a background run
    const startRunButton = page.getByTestId('start-run-button').first();
    await startRunButton.click();

    const taskInput = page.getByTestId('run-task-input').first();
    await expect(taskInput).toBeVisible();
    await taskInput.fill('E2E test navigate to detail');
    await taskInput.press('Enter');

    // Wait for active runs section
    const activeRunsSection = page.getByTestId('active-runs-section');
    await expect(activeRunsSection).toBeVisible({ timeout: 15000 });

    // Click the first active run row (not the cancel button)
    const runRow = activeRunsSection.locator('[role="button"]').first();
    await runRow.click();

    // Should navigate to the run detail page
    await expect(page).toHaveURL(/\/agents\/[^/]+\/runs\/[^/]+/);

    // The run detail page container should be visible
    const runDetailPage = page.getByTestId('run-detail-page');
    await expect(runDetailPage).toBeVisible({ timeout: 10000 });
  });
});
