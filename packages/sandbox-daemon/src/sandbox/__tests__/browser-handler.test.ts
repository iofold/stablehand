import { describe, expect, it, vi, beforeEach } from 'vitest';

const launchMock = vi.fn();
vi.mock('playwright', () => ({
  chromium: { launch: launchMock },
}));

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserProxySettings, createBrowserHandlers } from '../browser-handler.js';

const WORKSPACE = mkdtempSync(join(tmpdir(), 'browser-handler-test-'));

function mockBrowser() {
  const page = {
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    title: vi.fn(async () => 'Example Domain'),
    url: vi.fn(() => 'https://example.com/'),
    evaluate: vi.fn(async () => 'Example page text'),
    screenshot: vi.fn(async () => undefined),
  };
  const context = { newPage: vi.fn(async () => page) };
  const kill = vi.fn();
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
    process: vi.fn(() => ({ kill })),
  };
  launchMock.mockResolvedValue(browser);
  return { browser, page, kill };
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

  it('cuts off a call wedged inside evaluate and SIGKILLs the browser', async () => {
    const { browser, page, kill } = mockBrowser();
    // Playwright gives evaluate no timeout: simulate a wedged page.
    page.evaluate.mockImplementation(() => new Promise(() => undefined));
    const handlers = createBrowserHandlers({
      workspaceDir: WORKSPACE,
      hardCallTimeoutMs: 50,
      closeTimeoutMs: 20,
    });

    await expect(handlers.get('browse')!({ url: 'https://example.com' }))
      .rejects.toThrow(/cut off/);
    expect(browser.close).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('closes the browser even when the page load fails', async () => {
    const { browser, page } = mockBrowser();
    page.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const handlers = createBrowserHandlers({ workspaceDir: WORKSPACE });

    await expect(handlers.get('browse')!({ url: 'https://nope.invalid' }))
      .rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    expect(browser.close).toHaveBeenCalled();
  });

  it('runs parallel calls one browser at a time, and a failed call does not block the next', async () => {
    const { browser, page } = mockBrowser();
    let open = 0;
    let mostOpen = 0;
    launchMock.mockImplementation(async () => {
      open += 1;
      mostOpen = Math.max(mostOpen, open);
      return browser;
    });
    browser.close.mockImplementation(async () => {
      open -= 1;
    });
    page.goto
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error('net::ERR_CONNECTION_RESET');
      })
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    const handlers = createBrowserHandlers({ workspaceDir: WORKSPACE });

    // A model sends a whole round at once: three pages and three screenshots.
    const calls = ['a', 'b', 'c'].flatMap((site) => [
      handlers.get('browse')!({ url: `https://${site}.example.com` }),
      handlers.get('screenshot')!({ url: `https://${site}.example.com`, path: `shots/${site}.png` }),
    ]);
    const results = await Promise.allSettled(calls);

    expect(mostOpen).toBe(1);
    expect(launchMock).toHaveBeenCalledTimes(6);
    expect(results.map((result) => result.status)).toEqual([
      'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled',
    ]);
  });
});

describe('browser egress proxy (ctx-3aef)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('splits the session lease out of the proxy URL for Playwright', () => {
    expect(browserProxySettings('http://sess-1:YWdlbnQ.c2ln@egress:8081', 'localhost,orchestrator')).toEqual({
      server: 'http://egress:8081',
      bypass: 'localhost,orchestrator',
      username: 'sess-1',
      password: 'YWdlbnQ.c2ln',
    });
    expect(browserProxySettings('http://egress:8080', undefined)).toEqual({ server: 'http://egress:8080' });
    expect(browserProxySettings(undefined, 'localhost')).toBeUndefined();
  });

  it('launches Chromium with the lease as proxy credentials, never in --proxy-server', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://sess-1:tok@egress:8081');
    vi.stubEnv('NO_PROXY', 'localhost');
    vi.stubEnv('STABLEHAND_EGRESS_CA', '');
    mockBrowser();
    const handlers = createBrowserHandlers({ workspaceDir: WORKSPACE });

    await handlers.get('browse')!({ url: 'https://example.com' });

    const options = launchMock.mock.calls[0]?.[0] as { proxy?: Record<string, string>; args?: string[] };
    expect(options.proxy).toEqual({
      server: 'http://egress:8081',
      bypass: 'localhost',
      username: 'sess-1',
      password: 'tok',
    });
    expect(JSON.stringify(options.args)).not.toContain('tok');
    vi.unstubAllEnvs();
  });
});
