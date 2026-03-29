import { test, expect } from '@playwright/test';

test('A2UI BarChart rendering test', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';

  // Navigate to the chat page
  await page.goto(`/agents/${agentId}/chat`);
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15_000 });

  // Take initial screenshot
  const path1 = 'test-results/chart-test-01-initial.png';
  await page.screenshot({ path: path1 });
  console.log(`Screenshot 1: Initial page saved to ${path1}`);

  // Prepare the message
  const chartMessage = `Generate a bar chart visualization as a JSON block. Output it exactly in this format embedded in your response text: {"component":"BarChart","props":{"data":[{"name":"NYC","value":72},{"name":"London","value":59},{"name":"Tokyo","value":68},{"name":"Paris","value":61},{"name":"Sydney","value":77}],"xKey":"name","yKey":"value","title":"City Temperatures"}}. Just output that JSON block inline in your text.`;

  // Send the message
  const chatInput = page.getByTestId('chat-input');
  await chatInput.fill(chartMessage);
  
  // Wait for response to complete by looking for the run-finished marker
  const responsePromise = page.waitForSelector('[data-testid="run-finished"]', { timeout: 90_000 });
  
  const sendButton = page.getByTestId('send-button');
  await sendButton.click();

  // Wait for the assistant message to appear
  await expect(page.getByTestId('message-bubble-assistant').last()).toBeVisible({ timeout: 10_000 });

  // Take screenshot during streaming
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/02-streaming.png' });
  console.log('Screenshot 2: During response');

  // Wait for the response to finish streaming
  try {
    await responsePromise;
    await page.waitForTimeout(1000);
  } catch (e) {
    console.log('Response finished or timeout');
  }

  // Take final screenshot
  await page.screenshot({ path: '/tmp/03-final.png' });
  console.log('Screenshot 3: After response complete');

  // Check if BarChart is rendered
  const barChart = page.locator('svg[data-testid="barchart"]');
  const barChartVisible = await barChart.isVisible().catch(() => false);
  
  // Check if the raw JSON is still visible in the message
  const assistantMessage = page.getByTestId('message-bubble-assistant').last();
  const messageText = await assistantMessage.textContent();
  
  console.log('\n=== CHART RENDERING TEST RESULTS ===');
  console.log(`BarChart SVG visible: ${barChartVisible}`);
  console.log(`Message contains raw JSON: ${messageText?.includes('"component":"BarChart"') || false}`);
  console.log(`Message length: ${messageText?.length || 0}`);
  console.log(`\nFirst 200 chars of message: ${messageText?.substring(0, 200) || 'N/A'}`);
  
  // Try to find any SVG elements in the message
  const allSvgs = page.locator('svg');
  const svgCount = await allSvgs.count().catch(() => 0);
  console.log(`Total SVG elements on page: ${svgCount}`);
  
  // Look for Recharts containers
  const recharts = page.locator('[class*="recharts"]');
  const rechartCount = await recharts.count().catch(() => 0);
  console.log(`Recharts containers found: ${rechartCount}`);
  
  // Look for any div with data-testid containing "chart"
  const chartElements = page.locator('[data-testid*="chart"]');
  const chartCount = await chartElements.count().catch(() => 0);
  console.log(`Chart-related test ids found: ${chartCount}`);
  
  // Take close-up screenshot of the message area
  const bounds = await assistantMessage.boundingBox();
  if (bounds) {
    await page.screenshot({ 
      path: '/tmp/04-message-detail.png',
      clip: {
        x: Math.max(0, bounds.x - 10),
        y: Math.max(0, bounds.y - 10),
        width: bounds.width + 20,
        height: bounds.height + 20,
      }
    });
    console.log('Screenshot 4: Message detail');
  }

  // Report findings
  console.log('\n=== OBSERVATIONS ===');
  if (barChartVisible) {
    console.log('✓ BarChart component is rendering');
  } else {
    console.log('✗ BarChart component NOT found or not visible');
  }
  
  if (!messageText?.includes('"component":"BarChart"')) {
    console.log('✓ Raw JSON block is properly stripped from message text');
  } else {
    console.log('✗ Raw JSON block still visible in message text (not stripped)');
  }
});
