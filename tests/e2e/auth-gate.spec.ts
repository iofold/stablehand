import { test, expect } from '@playwright/test';

const API_TOKEN = process.env.CTXMILL_API_TOKEN ?? '';
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3200';

test.describe('API token gate @extended', () => {
  test.skip(!API_TOKEN, 'CTXMILL_API_TOKEN is required for auth-gate coverage');

  test('prompts unauthenticated browser sessions and stores accepted token', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    let stripAuthHeader = true;

    await page.route('**/api/**', async (route) => {
      const headers = { ...route.request().headers() };
      if (stripAuthHeader) {
        delete headers.authorization;
        delete headers.Authorization;
      }
      await route.continue({ headers });
    });

    try {
      await page.goto('/');

      const dialog = page.getByRole('dialog', { name: 'API token required' });
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      stripAuthHeader = false;
      await dialog.getByRole('textbox', { name: 'Token' }).fill(API_TOKEN);
      await dialog.getByRole('button', { name: 'Unlock' }).click();

      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await expect(page.evaluate(() => window.localStorage.getItem('ctxmill.apiToken'))).resolves.toBe(API_TOKEN);
    } finally {
      await context.close();
    }
  });
});
