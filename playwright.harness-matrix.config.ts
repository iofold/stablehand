import { defineConfig, devices } from '@playwright/test';

const apiAuthHeaders = process.env.CTXMILL_API_TOKEN
  ? { Authorization: `Bearer ${process.env.CTXMILL_API_TOKEN}` }
  : undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['harness-matrix.slice1.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  outputDir: '.tmp/test-results/harness-matrix',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '.tmp/playwright-report-harness-matrix' }]],
  timeout: 180_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Covers Playwright request fixture and page requests to the UI proxy.
    ...(apiAuthHeaders ? { extraHTTPHeaders: apiAuthHeaders } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
