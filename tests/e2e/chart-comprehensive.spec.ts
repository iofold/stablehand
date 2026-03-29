import { test, expect } from '@playwright/test';

test('A2UI Chart Rendering - Comprehensive Test', async ({ page }) => {
  console.log('\n🔍 TEST: A2UI BarChart Rendering Verification\n');
  
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';

  await page.goto(`/agents/${agentId}/chat`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });

  console.log('✓ Page loaded and chat input visible');

  const msg = `Generate a bar chart visualization as a JSON block. Output it exactly in this format embedded in your response text: {"component":"BarChart","props":{"data":[{"name":"NYC","value":72},{"name":"London","value":59},{"name":"Tokyo","value":68},{"name":"Paris","value":61},{"name":"Sydney","value":77}],"xKey":"name","yKey":"value","title":"City Temperatures"}}. Just output that JSON block inline in your text.`;

  const chatInput = page.getByTestId('chat-input');
  await chatInput.fill(msg);
  console.log('✓ Message sent');
  
  await page.getByTestId('send-button').click();
  
  const assistantMsg = page.getByTestId('message-bubble-assistant').last();
  await assistantMsg.waitFor({ state: 'visible', timeout: 10_000 });
  console.log('✓ Assistant response started streaming');

  await page.waitForTimeout(3000);
  
  let runFinished = false;
  try {
    await page.waitForSelector('[data-testid="run-finished"]', { timeout: 90_000 });
    runFinished = true;
    console.log('✓ Run finished marker detected');
  } catch (e) {
    console.log('⚠ Run finished marker not detected (may still be streaming)');
  }

  await page.waitForTimeout(2000);

  const msgText = await assistantMsg.textContent();
  const hasRawJson = msgText?.includes('"component":"BarChart"') || false;

  console.log('\n📊 FINDINGS:\n');
  console.log(`1. JSON Block Stripped: ${!hasRawJson ? '✓ YES' : '✗ NO'}`);
  
  const a2uiCount = await page.locator('[data-testid="a2ui-block"]').count();
  console.log(`2. A2UI Blocks Found: ${a2uiCount > 0 ? `✓ ${a2uiCount}` : '✗ 0'}`);
  
  const rechartsCount = await page.locator('svg.recharts-surface').count();
  console.log(`3. Recharts Surfaces: ${rechartsCount > 0 ? `✓ ${rechartsCount}` : '✗ 0'}`);
  
  const barCount = await page.locator('svg.recharts-surface rect').count();
  console.log(`4. Chart Bars Rendered: ${barCount > 0 ? `✓ ${barCount}` : '✗ 0'}`);

  const errors = await page.locator('[role="alert"], [class*="error"]').filter({ hasText: /Error|error|failed/i }).count();
  console.log(`5. Error Messages Visible: ${errors > 0 ? `✗ ${errors}` : '✓ None'}`);

  if (msgText) {
    const previewLen = Math.min(150, msgText.length);
    console.log(`\n📝 Message Preview:\n"${msgText.substring(0, previewLen)}..."\n`);
  }

  await page.screenshot({ path: 'test-results/final-comprehensive.png' });
  console.log('📸 Screenshot saved: final-comprehensive.png\n');

  console.log('='.repeat(60));
  if (!hasRawJson && (a2uiCount > 0 || rechartsCount > 0) && errors === 0) {
    console.log('✅ RESULT: CHART RENDERING WORKING');
  } else if (!hasRawJson && errors > 0) {
    console.log('⚠️  RESULT: JSON STRIPPED BUT RENDERING ERROR PRESENT');
  } else {
    console.log('❌ RESULT: CHART RENDERING NOT WORKING');
  }
  console.log('='.repeat(60) + '\n');
});
