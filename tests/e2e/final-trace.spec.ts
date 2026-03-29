import { test } from '@playwright/test';

test('Final trace of chart message loading', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const targetConvId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  // Set up network monitoring BEFORE navigation
  const apiCalls: Array<{url: string; status: number; data: any}> = [];
  
  page.on('response', async response => {
    if (response.url().includes('/api/agents/') && response.url().includes('/conversations/')) {
      try {
        const json = await response.json();
        apiCalls.push({
          url: response.url(),
          status: response.status(),
          data: json,
        });
      } catch (e) {
        // Ignore parse errors
      }
    }
  });

  console.log(`\n🎯 Testing conversation: ${targetConvId}`);
  
  // Navigate with explicit conversation ID
  await page.goto(`/agents/${agentId}/chat?conversationId=${targetConvId}`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(2000);

  console.log(`\n📡 API calls made: ${apiCalls.length}`);
  
  apiCalls.forEach((call, i) => {
    const isConvCall = call.url.includes('/messages');
    const convMatch = call.url.match(/conversations\/([a-f0-9-]+)/);
    const convId = convMatch?.[1] || 'unknown';
    
    if (isConvCall) {
      const msgCount = Array.isArray(call.data) ? call.data.length : 0;
      const hasChart = JSON.stringify(call.data).includes('"component":"BarChart"');
      
      console.log(`\n  Call ${i}: GET /messages`);
      console.log(`    Conversation ID: ${convId}`);
      console.log(`    Messages: ${msgCount}`);
      console.log(`    Contains chart JSON: ${hasChart}`);
      
      if (hasChart) {
        console.log(`    ✓ Chart JSON found!`);
      }
    }
  });

  // Check the loaded messages in the UI
  const allMsgs = page.getByTestId(/message-bubble-(user|assistant)/);
  const msgCount = await allMsgs.count();
  console.log(`\n📊 Messages rendered in UI: ${msgCount}`);
  
  // Check for the BarChart specifically
  const hasChartInDOM = await page.locator('body').evaluate(() => {
    return document.body.innerText.includes('"component":"BarChart"');
  });
  
  console.log(`   Raw BarChart JSON visible: ${hasChartInDOM}`);
  
  const a2uiBlocks = await page.locator('[data-testid="a2ui-block"]').count();
  console.log(`   A2UI blocks rendered: ${a2uiBlocks}`);

  // Final result
  console.log(`\n=== FINAL RESULT ===`);
  if (a2uiBlocks > 0) {
    console.log('✅ PASS: Chart is being rendered');
  } else if (hasChartInDOM) {
    console.log('⚠️  WARNING: Chart JSON is visible but NOT rendered as chart');
  } else {
    console.log('❌ FAIL: Chart not found in this conversation');
  }
});
