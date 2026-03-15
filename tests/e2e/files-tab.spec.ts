import { test, expect } from '@playwright/test';

const API = 'http://localhost:3001';

test.describe('Files Tab', () => {
  let agentId: string;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${API}/api/agents`);
    expect(res.ok()).toBe(true);
    const agents = await res.json();
    expect(agents.length).toBeGreaterThan(0);
    agentId = agents[0].id;
  });

  test('Files tab shows seed files', async ({ page }) => {
    await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });

    // Click the Files tab
    const filesTab = page.locator('[data-testid="files-tab"]');
    await expect(filesTab).toBeVisible();
    await filesTab.click();

    // Wait for the file explorer to appear
    const explorer = page.locator('[data-testid="file-explorer"]');
    await expect(explorer).toBeVisible();

    // Verify seed files are listed
    await expect(explorer.getByText('README.md')).toBeVisible();
    await expect(explorer.getByText('data')).toBeVisible();
  });

  test('Click file shows content in viewer', async ({ page }) => {
    await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });

    // Navigate to Files tab
    const filesTab = page.locator('[data-testid="files-tab"]');
    await expect(filesTab).toBeVisible();
    await filesTab.click();

    const explorer = page.locator('[data-testid="file-explorer"]');
    await expect(explorer).toBeVisible();

    // Click README.md
    await explorer.getByText('README.md').click();

    // Verify viewer appears with content
    const viewer = page.locator('[data-testid="file-viewer"]');
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText('Agent Workspace');
  });

  test('Navigate nested directory', async ({ page }) => {
    await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });

    // Navigate to Files tab
    const filesTab = page.locator('[data-testid="files-tab"]');
    await expect(filesTab).toBeVisible();
    await filesTab.click();

    const explorer = page.locator('[data-testid="file-explorer"]');
    await expect(explorer).toBeVisible();

    // Click the "data" directory to expand it
    await explorer.getByText('data').click();

    // Verify nested file appears
    await expect(explorer.getByText('sample-portfolio.json')).toBeVisible();
  });

  test('Read nested file content', async ({ page }) => {
    await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });

    // Navigate to Files tab
    const filesTab = page.locator('[data-testid="files-tab"]');
    await expect(filesTab).toBeVisible();
    await filesTab.click();

    const explorer = page.locator('[data-testid="file-explorer"]');
    await expect(explorer).toBeVisible();

    // Expand "data" directory
    await explorer.getByText('data').click();

    // Wait for nested file to appear, then click it
    const portfolioFile = explorer.getByText('sample-portfolio.json');
    await expect(portfolioFile).toBeVisible();
    await portfolioFile.click();

    // Verify viewer shows JSON content
    const viewer = page.locator('[data-testid="file-viewer"]');
    await expect(viewer).toBeVisible();

    // Check for known content in the portfolio file — assert each condition for clear failure messages
    const viewerText = await viewer.textContent();
    const containsAAPL = viewerText?.includes('AAPL') ?? false;
    const containsSamplePortfolio = viewerText?.includes('Sample Portfolio') ?? false;
    expect(
      containsAAPL || containsSamplePortfolio,
      `Viewer should contain "AAPL" or "Sample Portfolio", got: ${viewerText?.substring(0, 200)}`,
    ).toBe(true);
  });

  test('Files API returns correct data', async ({ request }) => {
    // List root directory
    const listRes = await request.get(
      `${API}/api/agents/${agentId}/files?path=.`,
    );
    expect(listRes.ok()).toBe(true);
    const listData = await listRes.json();
    const entries: { name: string; type: string }[] = listData.entries ?? [];
    const names = entries.map((e) => e.name);

    expect(names, 'Root should contain README.md').toContain('README.md');
    expect(names, 'Root should contain data directory').toContain('data');

    // List data subdirectory
    const subRes = await request.get(
      `${API}/api/agents/${agentId}/files?path=data`,
    );
    expect(subRes.ok()).toBe(true);
    const subData = await subRes.json();
    const subNames: string[] = (subData.entries ?? []).map(
      (e: { name: string }) => e.name,
    );
    expect(subNames, 'data/ should contain sample-portfolio.json').toContain(
      'sample-portfolio.json',
    );

    // Read a file
    const readRes = await request.get(
      `${API}/api/agents/${agentId}/files/read?path=README.md`,
    );
    expect(readRes.ok()).toBe(true);
    const readData = await readRes.json();
    expect(readData.content).toContain('Agent Workspace');
  });
});
