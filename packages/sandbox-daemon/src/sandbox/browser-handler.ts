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
/**
 * Absolute ceiling for one browse/screenshot call. Navigation timeouts do not
 * cover everything: page.evaluate has no timeout at all in Playwright, and a
 * wedged Chromium can hang browser.close() — either one used to strand the
 * tool call and hang the whole turn (observed live on alternating scheduled
 * runs). The race below is the guarantee; per-action timeouts are the polish.
 */
const HARD_CALL_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const TEXT_LIMIT = 40_000;
const LINK_LIMIT = 50;

interface BrowserHandlerOptions {
  workspaceDir: string;
  logger?: { warn(msg: string): void };
  /** Test override for the per-call ceiling; production uses the default. */
  hardCallTimeoutMs?: number;
  /** Test override for the close grace; production uses the default. */
  closeTimeoutMs?: number;
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

function deadline(ms: number, message: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Sandbox egress runs through the Stablehand proxy (ctx-2ctd). Chromium ignores the
 * HTTP(S)_PROXY environment and keeps its own trust store, so the proxy and the
 * deployment CA are wired in explicitly: the CA is imported once per process into the
 * NSS database Chromium reads, and every launch carries the proxy server and bypass list.
 */
function egressProxyServer(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || undefined;
}

let egressCaTrust: Promise<void> | undefined;

async function ensureEgressCaTrusted(): Promise<void> {
  const caPath = process.env.STABLEHAND_EGRESS_CA;
  if (!caPath) return;
  egressCaTrust ??= (async () => {
    const [{ execFile }, { promisify }, os, path, fs] = await Promise.all([
      import('node:child_process'),
      import('node:util'),
      import('node:os'),
      import('node:path'),
      import('node:fs/promises'),
    ]);
    const run = promisify(execFile);
    await fs.access(caPath);
    const dbDir = path.join(os.homedir(), '.pki', 'nssdb');
    await fs.mkdir(dbDir, { recursive: true });
    const db = `sql:${dbDir}`;
    try {
      await fs.access(path.join(dbDir, 'cert9.db'));
    } catch {
      await run('certutil', ['-d', db, '-N', '--empty-password']);
    }
    const listed = await run('certutil', ['-d', db, '-L']).catch(() => ({ stdout: '' }));
    if (!listed.stdout.includes('stablehand-egress')) {
      await run('certutil', ['-d', db, '-A', '-t', 'C,,', '-n', 'stablehand-egress', '-i', caPath]);
    }
  })();
  try {
    await egressCaTrust;
  } catch (err) {
    egressCaTrust = undefined;
    throw new Error(
      `Cannot trust the sandbox egress CA at ${caPath} for the browser: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

async function withPage<T>(
  run: (page: import('playwright').Page) => Promise<T>,
  timeouts: { hardCallTimeoutMs: number; closeTimeoutMs: number },
): Promise<T> {
  const { chromium } = await import('playwright');
  const proxyServer = egressProxyServer();
  if (proxyServer) await ensureEgressCaTrusted();
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(proxyServer
      ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy || undefined } }
      : {}),
  });
  const hardDeadline = deadline(
    timeouts.hardCallTimeoutMs,
    `Browser call exceeded ${timeouts.hardCallTimeoutMs / 1000}s and was cut off`,
  );
  try {
    return await Promise.race([
      hardDeadline.promise,
      (async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
        return run(page);
      })(),
    ]);
  } finally {
    hardDeadline.cancel();
    const closeDeadline = deadline(timeouts.closeTimeoutMs, 'close timed out');
    await Promise.race([
      browser.close().catch(() => undefined),
      closeDeadline.promise.catch(() => undefined),
    ]);
    closeDeadline.cancel();
    // A wedged Chromium survives close(); the process handle is the only
    // reliable cleanup. Killing an already-closed browser is a no-op error.
    try {
      // Not on the public Browser type, but present on launched browsers.
      const proc = (browser as unknown as { process?: () => { kill(sig: string): void } | null })
        .process?.();
      proc?.kill('SIGKILL');
    } catch { /* already gone */ }
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
  const timeouts = {
    hardCallTimeoutMs: options.hardCallTimeoutMs ?? HARD_CALL_TIMEOUT_MS,
    closeTimeoutMs: options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
  };

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
    }, timeouts);
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
    }, timeouts);
  });

  return handlers;
}
