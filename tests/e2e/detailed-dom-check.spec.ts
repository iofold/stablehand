import { test, expect } from '@playwright/test';

test('Check DOM for all messages', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const conversationId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  await page.goto(`/agents/${agentId}/chat?conversationId=${conversationId}`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });
  
  await page.waitForTimeout(3000);

  console.log('\n=== DETAILED DOM INSPECTION ===\n');

  // Check chat container
  const chatContainer = page.locator('[class*="chat"], [class*="message"]').first();
  
  // Get ALL elements with message-bubble
  const messageBubbles = page.locator('[data-testid*="message-bubble"]');
  const bubbleCount = await messageBubbles.count();
  console.log(`Message bubbles found: ${bubbleCount}`);

  // Get the message wrapper (the whole conversation area)
  const html = await page.locator('body').innerHTML();
  
  // Check for the specific assistant message ID in the HTML
  const hasAssistantId = html.includes('be83a257-da4d-45fa-8fb7-7709e9d57ef2');
  console.log(`Assistant message ID in DOM: ${hasAssistantId}`);
  
  // Check for the assistant message text
  const hasChartText = html.includes('bar chart visualization');
  console.log(`'bar chart visualization' text in DOM: ${hasChartText}`);
  
  // Check for BarChart component JSON
  const hasBarChartJson = html.includes('"component":"BarChart"');
  console.log(`BarChart JSON in DOM: ${hasBarChartJson}`);
  
  // Look for message content divs
  const messageDivs = page.locator('div[class*="message"], div[role="article"]');
  const divCount = await messageDivs.count();
  console.log(`\nMessage divs found: ${divCount}`);
  
  // Check visibility
  const userBubbles = page.getByTestId('message-bubble-user');
  const assistantBubbles = page.getByTestId('message-bubble-assistant');
  const userCount = await userBubbles.count();
  const assistantCount = await assistantBubbles.count();
  
  console.log(`User message bubbles: ${userCount}`);
  console.log(`Assistant message bubbles: ${assistantCount}`);
  
  // If assistant bubbles exist, check their content
  if (assistantCount > 0) {
    for (let i = 0; i < assistantCount; i++) {
      const text = await assistantBubbles.nth(i).textContent();
      console.log(`\nAssistant message ${i}: ${text?.substring(0, 100)}`);
    }
  }
});
