import { defineConfig, devices } from '@playwright/test';

const apiAuthHeaders = process.env.STABLEHAND_API_TOKEN
  ? { Authorization: `Bearer ${process.env.STABLEHAND_API_TOKEN}` }
  : undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  // Required release smoke runs through the same narrow Playwright discovery as
  // the full e2e suite, then selects intentional smoke tests by @smoke tag.
  testMatch: ['**/*.spec.ts'],
  grep: /@smoke/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  outputDir: '.tmp/test-results/smoke',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '.tmp/playwright-report-smoke' }]],
  timeout: 120_000,
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
