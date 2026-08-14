import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Daemon-side handlers for the browse/screenshot tools (ctx-lqas), driving
 * the Chromium baked into every harness image through Playwright.
 *
 * One browser launch per call: slower than a persistent context but leak-proof
 * — a crashed page can never strand a headless Chromium across turns. All
 * page work runs under hard timeouts so an unresponsive site fails the tool
 * call instead of hanging the turn.
 */

const NAVIGATION_TIMEOUT_MS = 20_000;
const SELECTOR_TIMEOUT_MS = 10_000;
const TEXT_LIMIT = 40_000;
const LINK_LIMIT = 50;

interface BrowserHandlerOptions {
  workspaceDir: string;
  logger?: { warn(msg: string): void };
}

function assertHttpUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('url is required');
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are supported, got ${parsed.protocol}`);
  }
  return parsed.toString();
}

function workspacePath(workspaceDir: string, requested: string): string {
  const resolved = path.resolve(workspaceDir, requested);
  if (resolved !== workspaceDir && !resolved.startsWith(`${workspaceDir}${path.sep}`)) {
    throw new Error('path must stay inside the workspace');
  }
  return resolved;
}

async function withPage<T>(
  run: (page: import('playwright').Page) => Promise<T>,
): Promise<T> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return await run(page);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function loadPage(
  page: import('playwright').Page,
  url: string,
  waitForSelector: unknown,
): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (typeof waitForSelector === 'string' && waitForSelector.length > 0) {
    await page.waitForSelector(waitForSelector, { timeout: SELECTOR_TIMEOUT_MS });
  } else {
    // Give SPAs a beat to hydrate without hanging on busy pages.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }
}

export function createBrowserHandlers(
  options: BrowserHandlerOptions,
): Map<string, (input: unknown) => Promise<string>> {
  const handlers = new Map<string, (input: unknown) => Promise<string>>();

  handlers.set('browse', async (rawInput: unknown) => {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const url = assertHttpUrl(input.url);
    return withPage(async (page) => {
      await loadPage(page, url, input.waitForSelector);
      const title = await page.title();
      // String-form evaluate: the daemon compiles without the DOM lib.
      const text = await page.evaluate<string>(
        'document.body ? document.body.innerText : ""',
      );
      const result: Record<string, unknown> = {
        url: page.url(),
        title,
        text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n…[truncated]` : text,
      };
      if (input.includeLinks === true) {
        result.links = await page.evaluate<Array<{ text: string; href: string }>>(
          `Array.from(document.querySelectorAll('a[href]'))
            .slice(0, ${LINK_LIMIT})
            .map((a) => ({
              text: (a.textContent || '').trim().slice(0, 120),
              href: a.href,
            }))`,
        );
      }
      return JSON.stringify(result);
    });
  });

  handlers.set('screenshot', async (rawInput: unknown) => {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    const url = assertHttpUrl(input.url);
    const parsed = new URL(url);
    const defaultName = `screenshots/${parsed.hostname}-${Date.now()}.png`;
    const requested = typeof input.path === 'string' && input.path.length > 0
      ? input.path
      : defaultName;
    const target = workspacePath(options.workspaceDir, requested);
    await mkdir(path.dirname(target), { recursive: true });
    return withPage(async (page) => {
      await loadPage(page, url, input.waitForSelector);
      await page.screenshot({
        path: target,
        fullPage: input.fullPage !== false,
      });
      return JSON.stringify({
        url: page.url(),
        title: await page.title(),
        path: path.relative(options.workspaceDir, target),
        note: 'Saved into the workspace; use artifact_upload to publish it.',
      });
    });
  });

  return handlers;
}
