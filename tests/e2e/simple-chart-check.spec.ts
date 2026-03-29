import { test } from '@playwright/test';

test('Simple chart check', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';

  await page.goto(`/agents/${agentId}/chat`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });

  const msg = `Generate a bar chart visualization as a JSON block. Output it exactly in this format embedded in your response text: {"component":"BarChart","props":{"data":[{"name":"NYC","value":72},{"name":"London","value":59},{"name":"Tokyo","value":68},{"name":"Paris","value":61},{"name":"Sydney","value":77}],"xKey":"name","yKey":"value","title":"City Temperatures"}}. Just output that JSON block inline in your text.`;

  const chatInput = page.getByTestId('chat-input');
  await chatInput.fill(msg);
  await page.getByTestId('send-button').click();

  await page.getByTestId('message-bubble-assistant').last().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(8000);

  try {
    await page.waitForSelector('[data-testid="run-finished"]', { timeout: 60_000 });
  } catch (e) {
    //
  }

  await page.waitForTimeout(2000);

  console.log('\n=== RESULTS ===');
  
  const a2uiBlocks = await page.locator('[data-testid="a2ui-block"]').count();
  console.log(`A2UI blocks: ${a2uiBlocks}`);
  
  const recharts = await page.locator('svg.recharts-surface').count();
  console.log(`Recharts SVG: ${recharts}`);
  
  const rects = await page.locator('svg.recharts-surface rect').count();
  console.log(`Bar elements: ${rects}`);
  
  const assistantMsg = await page.getByTestId('message-bubble-assistant').last().textContent();
  const hasJson = assistantMsg?.includes('"component"') || false;
  console.log(`JSON in text: ${hasJson}`);

  await page.screenshot({ path: 'test-results/simple-check.png' });
  console.log('\nScreenshot: simple-check.png');
});
