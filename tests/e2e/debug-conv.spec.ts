import { test, expect } from '@playwright/test';

test('Debug conversation messages', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const conversationId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  // Navigate directly to the conversation
  await page.goto(`/agents/${agentId}/chat?conversationId=${conversationId}`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });

  console.log('\n=== DEBUG CONVERSATION MESSAGE ORDER ===\n');
  
  // Wait for messages to load
  await page.waitForTimeout(3000);

  // Get ALL messages
  const allMessages = page.getByTestId(/message-bubble-(user|assistant)/);
  const msgCount = await allMessages.count();
  console.log(`Total messages: ${msgCount}`);
  
  // Get each message
  for (let i = 0; i < msgCount; i++) {
    const msg = allMessages.nth(i);
    const classList = await msg.evaluate(el => el.className);
    const text = await msg.textContent();
    const preview = text?.substring(0, 150).replace(/\n/g, ' ') || 'N/A';
    
    console.log(`\nMessage ${i}:`);
    console.log(`  Type: ${classList.includes('assistant') ? 'ASSISTANT' : 'USER'}`);
    console.log(`  Preview: ${preview}`);
    console.log(`  Full length: ${text?.length || 0} chars`);
  }

  // Take screenshot
  await page.screenshot({ path: '/tmp/debug-conv-screenshot.png' });
  console.log('\n\nScreenshot saved to /tmp/debug-conv-screenshot.png');
});
