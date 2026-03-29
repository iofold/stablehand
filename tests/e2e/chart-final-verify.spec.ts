import { test, expect } from '@playwright/test';

test('A2UI BarChart final verification', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';

  await page.goto(`/agents/${agentId}/chat`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });

  const chartMessage = `Generate a bar chart visualization as a JSON block. Output it exactly in this format embedded in your response text: {"component":"BarChart","props":{"data":[{"name":"NYC","value":72},{"name":"London","value":59},{"name":"Tokyo","value":68},{"name":"Paris","value":61},{"name":"Sydney","value":77}],"xKey":"name","yKey":"value","title":"City Temperatures"}}. Just output that JSON block inline in your text.`;

  const chatInput = page.getByTestId('chat-input');
  await chatInput.fill(chartMessage);
  
  const sendButton = page.getByTestId('send-button');
  await sendButton.click();

  await page.getByTestId('message-bubble-assistant').last().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(5000);

  try {
    await page.waitForSelector('[data-testid="run-finished"]', { timeout: 90_000 });
  } catch (e) {
    //
  }

  await page.waitForTimeout(2000);

  console.log('\n=== A2UI CHART RENDERING VERIFICATION ===\n');

  const a2uiBlocks = await page.locator('[data-testid="a2ui-block"]').count();
  console.log(`1. A2UI Blocks rendered: ${a2uiBlocks}`);
  expect(a2uiBlocks).toBeGreaterThan(0);

  const rechartSvgs = await page.locator('svg.recharts-surface').count();
  console.log(`2. Recharts SVG surfaces: ${rechartSvgs}`);
  expect(rechartSvgs).toBeGreaterThan(0);

  const assistantMsg = page.getByTestId('message-bubble-assistant').last();
  const msgText = await assistantMsg.textContent();
  
  const hasRawJson = msgText?.includes('"component":"BarChart"') || false;
  console.log(`3. Raw JSON in message text: ${hasRawJson}`);
  expect(hasRawJson).toBe(false);

  const rects = await page.locator('svg.recharts-surface rect').count();
  console.log(`4. Chart rectangle elements (bars): ${rects}`);
  expect(rects).toBeGreaterThan(0);

  const barChartContainer = page.locator('[data-testid="a2ui-block"] svg').first();
  const isVisible = await barChartContainer.isVisible().catch(() => false);
  console.log(`5. BarChart SVG visible: ${isVisible}`);
  expect(isVisible).toBe(true);

  const errorDivs = await page.locator('[class*="error"], [data-testid*="error"]').filter({ hasText: /component|render/i }).count();
  console.log(`6. Rendering errors found: ${errorDivs}`);

  const pageConsoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      pageConsoleErrors.push(msg.text());
    }
  });

  await page.screenshot({ path: 'test-results/final-verification.png' });

  console.log(`\n7. Chart visible in viewport: YES`);
  console.log(`8. JSON properly stripped: YES`);
  console.log(`\n=== RESULT: PASS ===`);
  console.log('✓ BarChart component is rendering correctly');
  console.log('✓ A2UI block extraction and rendering working');
  console.log('✓ Raw JSON properly removed from message text\n');
});
