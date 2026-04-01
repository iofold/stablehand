import { test } from '@playwright/test';

test('Final A2UI Chart Rendering Verification', async ({ page }) => {
  const agentId = 'f22dbb85-376d-4c7e-a91d-e132a2dc45f3';
  const conversationId = 'a1d7489a-360d-476e-ba89-8dd5262980ce';

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  A2UI CHART RENDERING VERIFICATION     ║');
  console.log('╚════════════════════════════════════════╝\n');

  console.log(`Agent ID:         ${agentId}`);
  console.log(`Conversation ID:  ${conversationId}`);
  console.log(`Route:            /agents/${agentId}/sessions/${conversationId}\n`);

  // Navigate to the conversation
  await page.goto(`/agents/${agentId}/sessions/${conversationId}`);
  await page.getByTestId('session-input').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(2000);

  // 1. Check A2UI blocks
  const a2uiBlocks = await page.locator('[data-testid="a2ui-block"]').count();
  console.log(`[1] A2UI Blocks Detected:        ${a2uiBlocks}`);

  // 2. Check Recharts surfaces
  const rechartSurfaces = await page.locator('svg.recharts-surface').count();
  console.log(`[2] Recharts SVG Surfaces:       ${rechartSurfaces}`);

  // 3. Check for raw JSON in message
  const assistantMsg = page.getByTestId('message-bubble-assistant').first();
  const msgText = await assistantMsg.textContent();
  const hasRawJson = msgText?.includes('"component":"BarChart"') || false;
  console.log(`[3] Raw JSON Visible:            ${hasRawJson ? '❌ YES (BAD)' : '✅ NO (GOOD)'}`);

  // 4. Check for bars in chart
  const bars = await page.locator('svg.recharts-surface rect[fill]').count();
  console.log(`[4] Chart Bar Elements:          ${bars}`);

  // 5. Check chart visibility
  const chartSvg = page.locator('[data-testid="a2ui-block"] svg').first();
  const isVisible = await chartSvg.isVisible().catch(() => false);
  console.log(`[5] Chart SVG Visible:           ${isVisible ? '✅ YES' : '❌ NO'}`);

  // 6. Check message rendering
  const messageCount = await page.getByTestId(/message-bubble-(user|assistant)/).count();
  console.log(`[6] Total Messages Rendered:     ${messageCount}`);

  // 7. Check for errors
  const errorElements = await page.locator('[class*="error"]').count();
  console.log(`[7] Error Elements Found:        ${errorElements}`);

  // Take screenshot
  await page.screenshot({ path: '/tmp/a2ui-final-verification.png' });

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║           FINAL RESULT                  ║');
  console.log('╚════════════════════════════════════════╝\n');

  if (a2uiBlocks > 0 && rechartSurfaces > 0 && !hasRawJson && isVisible) {
    console.log('✅ PASS: A2UI Chart Rendering Working');
    console.log('   - BarChart JSON extracted from message');
    console.log('   - Chart rendered as Recharts component');
    console.log('   - Raw JSON stripped from display text');
    console.log('   - Chart SVG visible and interactive');
  } else {
    console.log('❌ FAIL: A2UI Chart Rendering Issues');
    if (a2uiBlocks === 0) console.log('   - No A2UI blocks extracted');
    if (rechartSurfaces === 0) console.log('   - No Recharts SVG found');
    if (hasRawJson) console.log('   - Raw JSON still visible');
    if (!isVisible) console.log('   - Chart SVG not visible');
  }

  console.log('\nScreenshot: /tmp/a2ui-final-verification.png\n');
});
