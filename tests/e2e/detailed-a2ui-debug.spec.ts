import { test } from '@playwright/test';

test('Detailed chart rendering debug', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';

  await page.goto(`/agents/${agentId}/sessions/new`);
  await page.getByTestId('session-input').waitFor({ state: 'visible', timeout: 15_000 });

  const chartMessage = `Generate a bar chart visualization as a JSON block. Output it exactly in this format embedded in your response text: {"component":"BarChart","props":{"data":[{"name":"NYC","value":72},{"name":"London","value":59},{"name":"Tokyo","value":68},{"name":"Paris","value":61},{"name":"Sydney","value":77}],"xKey":"name","yKey":"value","title":"City Temperatures"}}. Just output that JSON block inline in your text.`;

  const chatInput = page.getByTestId('session-input');
  await chatInput.fill(chartMessage);
  
  const sendButton = page.getByTestId('send-button');
  await sendButton.click();

  await page.getByTestId('message-bubble-assistant').last().waitFor({ state: 'visible', timeout: 10_000 });

  await page.waitForTimeout(5000);

  try {
    await page.waitForSelector('[data-testid="run-finished"]', { timeout: 90_000 });
  } catch {
    // ignore
  }

  await page.waitForTimeout(2000);

  const assistantMsg = page.getByTestId('message-bubble-assistant').last();
  const html = await assistantMsg.innerHTML();
  
  console.log('\n=== SEARCHING FOR A2UI COMPONENTS ===');
  
  // Look for A2UIBlock-related elements
  const hasA2UIBlock = html.includes('A2UIBlock') || html.includes('a2ui-block');
  console.log(`A2UIBlock div found: ${hasA2UIBlock}`);
  
  // Look for data-testid="a2ui-block"
  const a2uiBlockElements = await page.locator('[data-testid="a2ui-block"]').count();
  console.log(`A2UI block elements with testid: ${a2uiBlockElements}`);
  
  // Look for any div with BarChart class
  const barChartDivs = await page.locator('div[class*="BarChart"]').count();
  console.log(`BarChart divs found: ${barChartDivs}`);
  
  // Look for Rechart component structure
  const rechartSvgs = await page.locator('svg.recharts-surface').count();
  console.log(`Recharts SVGs found: ${rechartSvgs}`);
  
  // Look for any SVG with class containing "chart"
  const chartSvgs = await page.locator('svg[class*="chart"]').count();
  console.log(`SVGs with "chart" in class: ${chartSvgs}`);
  
  // Check for error boundaries or error states
  const errors = await page.locator('[data-testid="a2ui-error"]').count();
  console.log(`A2UI errors found: ${errors}`);
  
  // Look for the JSON text in the message
  if (html.includes('"component":"BarChart"')) {
    console.log('✗ Raw JSON found - NOT stripped');
  } else {
    console.log('✓ Raw JSON properly stripped');
  }
  
  // Search entire page for BarChart component
  const pageContent = await page.content();
  const barChartMatches = pageContent.match(/BarChart/g) || [];
  console.log(`Total "BarChart" occurrences in page: ${barChartMatches.length}`);
  
  // Look for the A2UIBlock rendering in the message area
  const msgText = await assistantMsg.textContent();
  console.log(`\nMessage text preview (first 300 chars):\n${msgText?.substring(0, 300)}`);
  
  await page.screenshot({ path: 'test-results/detailed-debug.png' });
});
