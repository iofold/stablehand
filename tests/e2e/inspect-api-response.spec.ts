import { test } from '@playwright/test';

test('Inspect API response for messages', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const conversationId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  // Intercept network responses
  const responses: unknown[] = [];
  page.on('response', async response => {
    if (response.url().includes('/messages')) {
      const json = await response.json().catch(() => null);
      responses.push({
        url: response.url(),
        status: response.status(),
        data: json,
      });
    }
  });

  await page.goto(`/agents/${agentId}/sessions/new?conversationId=${conversationId}`);
  await page.getByTestId('session-input').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(3000);

  console.log('\n=== API RESPONSES INTERCEPTED ===\n');
  console.log(JSON.stringify(responses, null, 2));
});
