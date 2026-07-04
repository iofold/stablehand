import { test as base, expect, type Page, type Request } from '@playwright/test';

const ALLOWED_CONSOLE_ERROR_PATTERNS = [
  // Keep this list intentionally empty unless a release gate ADR accepts a known benign browser error.
] as const;

function shouldStripAuthHeader(url: string): boolean {
  try {
    const parsed = new URL(url);
    const base = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3200');
    return parsed.origin !== base.origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function isAllowedConsoleError(text: string): boolean {
  return ALLOWED_CONSOLE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function formatRequestFailure(request: Request): string {
  const failure = request.failure();
  return `${request.method()} ${request.url()}${failure ? `: ${failure.errorText}` : ''}`;
}

export async function assertNoUnexpectedTerminalErrorStates(
  sessions: Array<{ id?: string; sessionId?: string; status?: string | null; error?: unknown }>,
  options: { allowCancelled?: boolean } = {},
): Promise<void> {
  const unexpected = sessions.filter((session) => {
    const status = String(session.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed') return true;
    if (status === 'cancelled' && !options.allowCancelled) return true;
    return false;
  });

  if (unexpected.length === 0) return;

  // Surface error details inline so the gate failure points at the cause.
  const summary = unexpected
    .map((session) => {
      const id = session.id ?? session.sessionId ?? '<unknown-id>';
      const status = session.status ?? '<unknown-status>';
      const error = session.error
        ? typeof session.error === 'string'
          ? session.error
          : JSON.stringify(session.error)
        : '<no error detail>';
      return `  - session=${id} status=${status} error=${error}`;
    })
    .join('\n');

  expect(
    unexpected,
    `[ADR-008] unexpected terminal error sessions:\n${summary}`,
  ).toEqual([]);
}

async function installStrictConsoleGate(page: Page, errors: string[]): Promise<void> {
  await page.route('**/*', async (route) => {
    const headers = route.request().headers();
    if (!headers.authorization || !shouldStripAuthHeader(route.request().url())) {
      await route.continue();
      return;
    }

    const nextHeaders = { ...headers };
    delete nextHeaders.authorization;
    await route.continue({ headers: nextHeaders });
  });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!isAllowedConsoleError(text)) {
      errors.push(`console.error: ${text}`);
    }
  });

  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  page.on('requestfailed', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.includes('/favicon.ico')) return;
    errors.push(`requestfailed: ${formatRequestFailure(request)}`);
  });
}

export const test = base.extend<{ strictConsoleErrors: string[] }>({
  strictConsoleErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    await installStrictConsoleGate(page, errors);
    await use(errors);
    expect(errors, `unexpected browser console/runtime failures:\n${errors.join('\n')}`).toEqual([]);
  }, { auto: true }],
});

export { expect };
