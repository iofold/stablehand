import { test as base, expect, type Page, type Request } from '@playwright/test';

const ALLOWED_CONSOLE_ERROR_PATTERNS = [
  // Keep this list intentionally empty unless a release gate ADR accepts a known benign browser error.
] as const;

function isAllowedConsoleError(text: string): boolean {
  return ALLOWED_CONSOLE_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function formatRequestFailure(request: Request): string {
  const failure = request.failure();
  return `${request.method()} ${request.url()}${failure ? `: ${failure.errorText}` : ''}`;
}

export async function assertNoUnexpectedTerminalErrorStates(
  sessions: Array<{ id?: string; sessionId?: string; status?: string | null; error?: unknown }>,
): Promise<void> {
  const unexpected = sessions.filter((session) => {
    const status = String(session.status ?? '').toLowerCase();
    return status === 'error' || status === 'failed' || status === 'cancelled';
  });

  expect(
    unexpected,
    `unexpected terminal error sessions: ${JSON.stringify(unexpected, null, 2)}`,
  ).toEqual([]);
}

async function installStrictConsoleGate(page: Page, errors: string[]): Promise<void> {
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
