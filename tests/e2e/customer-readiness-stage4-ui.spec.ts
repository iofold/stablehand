/**
 * Customer-readiness Stage 4 UI smoke (Track 4).
 *
 * Covers:
 *   - Dashboard load-failure renders the error banner with retry, NOT the
 *     onboarding empty state. (ctx-wrx)
 *   - Files-tab workspace upload happy path: drag/drop a .tar.gz archive
 *     against a real agent and confirm the success message renders.
 *   - Files-tab workspace upload reject path: picking a .zip file is rejected
 *     pre-upload with no network call. (ctx-h99)
 *
 * The dashboard error scenario uses route mocking. Files-tab paths use a
 * real agent via the orchestrator API.
 */
import { test, expect } from '@playwright/test';
import { createTestAgent, deleteTestAgent } from './support';

test.describe('Customer Readiness Stage 4 — UI', () => {
  test('dashboard renders load-failure banner with retry instead of onboarding', async ({ page }) => {
    // Force the agents endpoint to fail before navigation. The dashboard
    // store reads this and the UI must render the dashboard-load-error
    // alert (NOT the onboarding "No agents yet" panel).
    await page.route('**/api/agents', async (route) => {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service unavailable' }) });
    });

    await page.goto('/');
    await expect(page.getByTestId('dashboard-load-error')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Failed to load agents')).toBeVisible();
    await expect(page.getByText('No agents yet')).toHaveCount(0);
    // Retry button is present and clickable.
    await expect(page.getByTestId('dashboard-retry-button')).toBeVisible();
  });

  test.describe('files tab workspace upload', () => {
    let agentId = '';

    test.beforeAll(async ({ request }) => {
      const agent = await createTestAgent(request, {
        name: `stage4-files-${Date.now()}`,
        description: 'Stage 4 files-tab upload happy/reject smoke',
      });
      agentId = agent.id;
    });

    test.afterAll(async ({ request }) => {
      if (agentId) await deleteTestAgent(request, agentId);
    });

    test('rejects a non-tar.gz file pre-upload with no network call', async ({ page }) => {
      let uploadCalled = false;
      // Listen for any POST to the workspace upload endpoint to confirm we
      // do NOT send bytes when the client-side validator rejects the file.
      await page.route('**/api/agents/*/workspace*', async (route) => {
        if (route.request().method() === 'POST') uploadCalled = true;
        await route.fallback();
      });

      await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });
      await page.getByTestId('files-tab').click();

      const input = page.getByTestId('workspace-upload-input');
      await input.setInputFiles({
        name: 'archive.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('not a tar.gz'),
      });

      // The inline error banner appears (role="alert", red).
      await expect(page.getByText('must be a .tar.gz or .tgz')).toBeVisible({ timeout: 5_000 });
      expect(uploadCalled).toBe(false);
    });

    test('uploads a tar.gz archive and shows the success message', async ({ page }) => {
      // Build a minimal valid tar.gz in-memory: a single 4-byte file at root.
      // We use Node's stream APIs via a serialized buffer here — the test
      // body is intentionally lightweight to keep this spec focused.
      const tarGzBuffer = await buildSingleFileTarGz('hello.txt', 'hi!\n');

      await page.goto(`/agents/${agentId}`, { waitUntil: 'networkidle' });
      await page.getByTestId('files-tab').click();

      const input = page.getByTestId('workspace-upload-input');
      await input.setInputFiles({
        name: 'workspace.tar.gz',
        mimeType: 'application/gzip',
        buffer: tarGzBuffer,
      });

      // Success message renders with file count + bytes from the API response.
      await expect(page.getByText(/Uploaded workspace archive/)).toBeVisible({ timeout: 15_000 });
    });
  });
});

/**
 * Minimal in-memory tar.gz builder using tar-stream + node:zlib. Returns a
 * Buffer containing a gzip-compressed tar archive with a single file.
 */
async function buildSingleFileTarGz(name: string, content: string): Promise<Buffer> {
  // Dynamic imports keep this spec import-graph friendly even when run in
  // contexts that don't have these packages hoisted at the top level.
  const tar = await import('tar-stream');
  const { createGzip } = await import('node:zlib');

  return await new Promise<Buffer>((resolvePromise, reject) => {
    const pack = tar.pack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];

    pack.entry({ name, size: Buffer.byteLength(content) }, content, (err) => {
      if (err) {
        reject(err);
        return;
      }
      pack.finalize();
    });

    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gzip.on('end', () => resolvePromise(Buffer.concat(chunks)));
    gzip.on('error', reject);
    pack.on('error', reject);
    pack.pipe(gzip);
  });
}
