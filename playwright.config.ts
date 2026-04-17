import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/*.spec.ts'],
  testIgnore: [
    '**/chart-*.spec.ts',
    '**/debug-*.spec.ts',
    '**/detailed-*.spec.ts',
    '**/final-*.spec.ts',
    '**/inspect-api-response.spec.ts',
    '**/orchestrator-scenarios.test.ts',
    '**/screenshot-full-chart.spec.ts',
    '**/simple-chart-check.spec.ts',
    '**/test-correct-route.spec.ts',
    '**/trace-conv-id.spec.ts',
    '**/verify-existing-conversation.spec.ts',
  ],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-docker' }]],
  timeout: 120_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
