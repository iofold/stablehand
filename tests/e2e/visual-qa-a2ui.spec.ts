import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent, waitForRunStatus } from './support.js';
import { hasHarnessKey } from './visual-qa/support.js';
import { ScreenshotCapture } from './visual-qa/screenshot-capture.js';

test.describe('A2UI Chart Rendering Visual QA @extended', () => {
  test.skip(!hasHarnessKey('langgraph'), 'Skipping: OPENAI_API_KEY not available');

  let agentId = '';

  test.beforeEach(async ({ request }) => {
    const agent = await createTestAgent(request, {
      name: `vqa-a2ui-${Date.now()}`,
      harness: 'langgraph',
      harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
      systemPrompt: `You are a data visualization agent. When asked to generate a chart, include the chart data as a JSON block in your response.

When asked for a bar chart, include this exact JSON block inline in your response:
{"component":"BarChart","props":{"data":[{"name":"NYC","value":72},{"name":"London","value":59},{"name":"Tokyo","value":68},{"name":"Paris","value":61},{"name":"Sydney","value":77}],"xKey":"name","yKey":"value","title":"City Temperatures"}}

When asked for a line chart, include this exact JSON block inline:
{"component":"LineChart","props":{"data":[{"month":"Jan","sales":30},{"month":"Feb","sales":45},{"month":"Mar","sales":55},{"month":"Apr","sales":40},{"month":"May","sales":65}],"xKey":"month","yKey":"sales","title":"Monthly Sales"}}

When asked for a pie chart, include this exact JSON block inline:
{"component":"PieChart","props":{"data":[{"name":"Chrome","value":65},{"name":"Firefox","value":15},{"name":"Safari","value":12},{"name":"Edge","value":8}],"nameKey":"name","valueKey":"value","title":"Browser Market Share"}}

Always output the JSON block as part of your natural text response. Surround it with brief explanation text.`,
      tools: ['emit-event'],
      description: 'VQA A2UI chart test agent',
    });
    agentId = agent.id;
  });

  test.afterEach(async ({ request }) => {
    if (agentId) await deleteTestAgent(request, agentId);
  });

  test('renders BarChart from inline JSON block', async ({ page, request }) => {
    const capture = new ScreenshotCapture(page, 'a2ui-barchart', 'live');

    await page.goto(`/agents/${agentId}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    const sendResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().includes(`/api/agents/${agentId}/message`) &&
      response.ok(),
    );
    await page.getByTestId('session-input').fill('Generate a bar chart of city temperatures');
    await page.getByTestId('send-button').click();
    const sendBody = await (await sendResponsePromise).json() as { sessionId: string };
    await waitForRunStatus(request, agentId, sendBody.sessionId, ['completed', 'error'], 120_000);

    await page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 120_000 });
    await capture.captureViewport('a2ui-barchart-finished', 'Run complete with BarChart');

    // Check for A2UI block
    const a2uiBlock = page.getByTestId('a2ui-block');
    const hasBlock = await a2uiBlock.first().isVisible().catch(() => false);
    if (hasBlock) {
      await capture.captureComponent(a2uiBlock.first(), 'a2ui-barchart-component', 'BarChart A2UI block');
    }

    // Check for SVG elements (recharts renders SVG)
    const svgElements = page.locator('svg');
    const svgCount = await svgElements.count();
    expect(svgCount).toBeGreaterThan(0);

    // Check for recharts containers
    const rechartsContainers = page.locator('[class*="recharts"]');
    await expect(rechartsContainers.first()).toBeVisible({ timeout: 15_000 });

    // Capture the assistant message area
    const assistantMsg = page.getByTestId('message-bubble-assistant').last();
    if (await assistantMsg.isVisible().catch(() => false)) {
      await capture.captureComponent(assistantMsg, 'a2ui-barchart-message', 'Full assistant message with chart');
    }

    await capture.writeManifest();
  });

  test('renders LineChart from inline JSON block', async ({ page }) => {
    const capture = new ScreenshotCapture(page, 'a2ui-linechart', 'live');

    await page.goto(`/agents/${agentId}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('session-input').fill('Generate a line chart of monthly sales data');
    await page.getByTestId('send-button').click();

    await page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 120_000 });
    await capture.captureViewport('a2ui-linechart-finished', 'Run complete with LineChart');

    const a2uiBlock = page.getByTestId('a2ui-block');
    const hasBlock = await a2uiBlock.first().isVisible().catch(() => false);
    if (hasBlock) {
      await capture.captureComponent(a2uiBlock.first(), 'a2ui-linechart-component', 'LineChart A2UI block');
    }

    const assistantMsg = page.getByTestId('message-bubble-assistant').last();
    if (await assistantMsg.isVisible().catch(() => false)) {
      await capture.captureComponent(assistantMsg, 'a2ui-linechart-message', 'Full assistant message with line chart');
    }

    await capture.writeManifest();
  });

  test('renders PieChart from inline JSON block', async ({ page }) => {
    const capture = new ScreenshotCapture(page, 'a2ui-piechart', 'live');

    await page.goto(`/agents/${agentId}/sessions/new`);
    await expect(page.getByTestId('session-input')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('session-input').fill('Generate a pie chart of browser market share');
    await page.getByTestId('send-button').click();

    await page.waitForSelector('[data-testid="run-finished"]', { state: 'attached', timeout: 120_000 });
    await capture.captureViewport('a2ui-piechart-finished', 'Run complete with PieChart');

    const a2uiBlock = page.getByTestId('a2ui-block');
    const hasBlock = await a2uiBlock.first().isVisible().catch(() => false);
    if (hasBlock) {
      await capture.captureComponent(a2uiBlock.first(), 'a2ui-piechart-component', 'PieChart A2UI block');
    }

    await capture.writeManifest();
  });
});
