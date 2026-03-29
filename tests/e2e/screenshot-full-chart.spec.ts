import { test } from '@playwright/test';

test('Capture full chart screenshot', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const targetConvId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  await page.goto(`/agents/${agentId}/chat/${targetConvId}`);
  await page.getByTestId('chat-input').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(3000);

  // Scroll to the message area
  const chatThread = page.locator('[class*="chat"]').first();
  await chatThread.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);

  // Find and scroll to the A2UI block
  const a2uiBlock = page.locator('[data-testid="a2ui-block"]').first();
  if (await a2uiBlock.isVisible()) {
    await a2uiBlock.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    
    // Take screenshot of just the block
    const box = await a2uiBlock.boundingBox();
    if (box) {
      await page.screenshot({
        path: '/tmp/chart-detail.png',
        clip: {
          x: Math.max(0, box.x - 20),
          y: Math.max(0, box.y - 20),
          width: box.width + 40,
          height: box.height + 40,
        }
      });
      console.log('✓ Chart detail screenshot taken');
    }
  }

  // Full page screenshot  
  await page.screenshot({ path: '/tmp/chart-full-page.png' });
  console.log('✓ Full page screenshot taken');
});
