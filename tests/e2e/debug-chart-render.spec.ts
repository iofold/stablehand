import { test } from '@playwright/test';

test('Debug chart rendering', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';

  await page.goto(`/agents/${agentId}/sessions/new`);
  await page.getByTestId('session-input').waitFor({ state: 'visible', timeout: 15_000 });

  const chartMessage = `Generate a bar chart visualization as a JSON block. Output it exactly in this format embedded in your response text: {"component":"BarChart","props":{"data":[{"name":"NYC","value":72},{"name":"London","value":59},{"name":"Tokyo","value":68},{"name":"Paris","value":61},{"name":"Sydney","value":77}],"xKey":"name","yKey":"value","title":"City Temperatures"}}. Just output that JSON block inline in your text.`;

  const chatInput = page.getByTestId('session-input');
  await chatInput.fill(chartMessage);
  
  const sendButton = page.getByTestId('send-button');
  await sendButton.click();

  await page.getByTestId('message-bubble-assistant').last().waitFor({ state: 'visible', timeout: 10_000 });

  await page.waitForTimeout(3000);

  try {
    await page.waitForSelector('[data-testid="run-finished"]', { timeout: 90_000 });
  } catch {
    console.log('Run finished marker timeout');
  }

  await page.waitForTimeout(2000);

  const assistantMsg = page.getByTestId('message-bubble-assistant').last();
  const html = await assistantMsg.innerHTML();
  
  console.log('\n=== MESSAGE HTML ===');
  console.log(html.substring(0, 500));
  console.log('...');
  console.log(html.substring(html.length - 500));
  
  const allContent = await page.content();
  if (allContent.includes('BarChart') || allContent.includes('barchart')) {
    console.log('✓ BarChart found somewhere in page HTML');
  } else {
    console.log('✗ BarChart NOT found in page HTML');
  }
  
  if (allContent.includes('recharts') || allContent.includes('Recharts')) {
    console.log('✓ Recharts references found');
  } else {
    console.log('✗ No Recharts references found');
  }

  await page.screenshot({ path: 'test-results/debug-chart.png' });
  console.log('Screenshot saved');
});
