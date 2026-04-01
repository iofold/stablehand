import { test } from '@playwright/test';

test('Load conversation using correct route format', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const targetConvId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  // Use the route parameter format instead of query param
  const correctRoute = `/agents/${agentId}/sessions/${targetConvId}`;
  
  console.log(`\n📍 Navigating to: ${correctRoute}`);
  
  await page.goto(correctRoute);
  await page.getByTestId('session-input').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(3000);

  // Check what messages are loaded
  const allMsgs = page.getByTestId(/message-bubble-(user|assistant)/);
  const msgCount = await allMsgs.count();
  
  console.log(`📊 Messages loaded: ${msgCount}`);
  
  // Check for the BarChart
  const a2uiBlocks = await page.locator('[data-testid="a2ui-block"]').count();
  console.log(`   A2UI blocks rendered: ${a2uiBlocks}`);
  
  const hasChartInDOM = await page.locator('body').evaluate(() => {
    return document.body.innerText.includes('"component":"BarChart"');
  });
  console.log(`   BarChart JSON in DOM: ${hasChartInDOM}`);
  
  const recharts = await page.locator('svg.recharts-surface').count();
  console.log(`   Recharts rendered: ${recharts}`);

  // Final verdict
  console.log(`\n=== VERIFICATION ===`);
  if (a2uiBlocks > 0 && recharts > 0) {
    console.log('✅ SUCCESS: Chart is rendered!');
  } else if (hasChartInDOM && a2uiBlocks === 0) {
    console.log('❌ FAIL: Chart JSON present but not rendered');
  } else {
    console.log('⚠️  Chart not found in loaded messages');
  }

  // Take screenshot
  await page.screenshot({ path: '/tmp/correct-route-screenshot.png' });
});
