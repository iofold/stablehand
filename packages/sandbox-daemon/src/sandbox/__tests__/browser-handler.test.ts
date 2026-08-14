import { describe, expect, it, vi, beforeEach } from 'vitest';

const launchMock = vi.fn();
vi.mock('playwright', () => ({
  chromium: { launch: launchMock },
}));

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserHandlers } from '../browser-handler.js';

const WORKSPACE = mkdtempSync(join(tmpdir(), 'browser-handler-test-'));

function mockBrowser() {
  const page = {
    setDefaultNavigationTimeout: vi.fn(),
    goto: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    title: vi.fn(async () => 'Example Domain'),
    url: vi.fn(() => 'https://example.com/'),
    evaluate: vi.fn(async () => 'Example page text'),
    screenshot: vi.fn(async () => undefined),
  };
  const context = { newPage: vi.fn(async () => page) };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  launchMock.mockResolvedValue(browser);
  return { browser, page };
}

describe('browser-handler (ctx-lqas)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('browse loads the page and returns title and text, closing the browser', async () => {
    const { browser, page } = mockBrowser();
    const handlers = createBrowserHandlers({ workspaceDir: WORKSPACE });

    const raw = await handlers.get('browse')!({ url: 'https://example.com' });
    const result = JSON.parse(raw);

    expect(page.goto).toHaveBeenCalledWith('https://example.com/', { waitUntil: 'domcontentloaded' });
    expect(result).toMatchObject({ title: 'Example Domain', text: 'Example page text' });
    expect(result.links).toBeUndefined();
    expect(browser.close).toHaveBeenCalled();
  });

  it('rejects non-http(s) URLs before launching anything', async () => {
    const handlers = createBrowserHandlers({ workspaceDir: WORKSPACE });
    await expect(handlers.get('browse')!({ url: 'file:///etc/passwd' }))
      .rejects.toThrow(/Only http\(s\) URLs/);
    await expect(handlers.get('screenshot')!({ url: 'javascript:alert(1)' }))
      .rejects.toThrow();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('screenshot saves inside the workspace and refuses escapes', async () => {
    const { page } = mockBrowser();
    const handlers = createBrowserHandlers({ workspaceDir: WORKSPACE });

    const raw = await handlers.get('screenshot')!({
      url: 'https://example.com',
      path: 'shots/page.png',
    });
    const result = JSON.parse(raw);
    expect(page.screenshot).toHaveBeenCalledWith({ path: join(WORKSPACE, 'shots/page.png'), fullPage: true });
    expect(result.path).toBe('shots/page.png');

    await expect(handlers.get('screenshot')!({
      url: 'https://example.com',
      path: '../outside.png',
    })).rejects.toThrow(/inside the workspace/);
  });

  it('closes the browser even when the page load fails', async () => {
    const { browser, page } = mockBrowser();
    page.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const handlers = createBrowserHandlers({ workspaceDir: WORKSPACE });

    await expect(handlers.get('browse')!({ url: 'https://nope.invalid' }))
      .rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    expect(browser.close).toHaveBeenCalled();
  });
});
