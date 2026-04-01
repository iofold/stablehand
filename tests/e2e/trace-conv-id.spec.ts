import { test } from '@playwright/test';

test('Trace conversation ID through chat', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const targetConvId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  console.log('\nTarget conversation ID:', targetConvId);

  // Navigate with explicit conversation ID
  const navUrl = `/agents/${agentId}/sessions/new?conversationId=${targetConvId}`;
  console.log('Navigation URL:', navUrl);
  
  await page.goto(navUrl);
  await page.getByTestId('session-input').waitFor({ state: 'visible', timeout: 15_000 });

  // Check what the page's URL is
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  // Get the actual conversation ID from the loaded messages
  let loadedConvId: string | null = null;
  page.on('response', response => {
    if (response.url().includes('/conversations/')) {
      const match = response.url().match(/conversations\/([^/]+)\//);
      if (match) {
        loadedConvId = match[1];
      }
    }
  });

  await page.waitForTimeout(3000);
  
  console.log('Loaded conversation ID:', loadedConvId);
  
  if (loadedConvId !== targetConvId) {
    console.log('\n❌ ISSUE: Wrong conversation loaded!');
    console.log(`   Expected: ${targetConvId}`);
    console.log(`   Got: ${loadedConvId}`);
  } else {
    console.log('\n✓ Correct conversation loaded');
  }
});
