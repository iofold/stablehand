import { test, expect } from '@playwright/test';

test('A2UI BarChart in existing conversation', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const conversationId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  // Navigate directly to the conversation
  await page.goto(`/agents/${agentId}/chat?conversationId=${conversationId}`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });

  console.log('\n=== EXISTING CONVERSATION A2UI TEST ===\n');
  
  // Wait for messages to load
  await page.waitForTimeout(2000);

  // Get the assistant message (second message in the thread)
  const assistantMessages = page.getByTestId('message-bubble-assistant');
  const msgCount = await assistantMessages.count();
  console.log(`Total assistant messages: ${msgCount}`);
  
  if (msgCount > 0) {
    const firstAssistantMsg = assistantMessages.first();
    const msgText = await firstAssistantMsg.textContent();
    
    console.log(`\nAssistant message preview (first 300 chars):`);
    console.log(msgText?.substring(0, 300) || 'N/A');
    
    // Check for A2UI blocks
    const a2uiBlocks = await page.locator('[data-testid="a2ui-block"]').count();
    console.log(`\n1. A2UI Blocks rendered: ${a2uiBlocks}`);
    
    // Check for Recharts
    const rechartSvgs = await page.locator('svg.recharts-surface').count();
    console.log(`2. Recharts SVG surfaces: ${rechartSvgs}`);
    
    // Check if raw JSON is in the message
    const hasRawJson = msgText?.includes('"component":"BarChart"') || false;
    console.log(`3. Raw JSON in assistant message: ${hasRawJson}`);
    
    // Check for bar elements
    const rects = await page.locator('svg.recharts-surface rect').count();
    console.log(`4. Chart rectangle elements (bars): ${rects}`);
    
    // Check visibility
    const barChartContainer = page.locator('[data-testid="a2ui-block"] svg').first();
    const isVisible = await barChartContainer.isVisible().catch(() => false);
    console.log(`5. BarChart SVG visible: ${isVisible}`);

    // Take screenshot of message area
    await page.screenshot({ path: '/tmp/existing-conv-screenshot.png' });
    console.log('\nScreenshot saved to /tmp/existing-conv-screenshot.png');
    
    // Report findings
    console.log(`\n=== VERIFICATION RESULTS ===`);
    if (rechartSvgs > 0 && !hasRawJson && isVisible) {
      console.log('✓ PASS: Chart renders, JSON stripped, SVG visible');
    } else {
      console.log('✗ ISSUE FOUND:');
      if (rechartSvgs === 0) console.log('  - No Recharts SVG found');
      if (hasRawJson) console.log('  - Raw JSON still visible in message');
      if (!isVisible) console.log('  - Chart SVG not visible');
    }
  } else {
    console.log('✗ No assistant messages found');
  }
});
