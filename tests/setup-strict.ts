import { beforeEach, afterEach, expect } from 'vitest';

/**
 * Strict test harness — fails tests on internal errors that would otherwise
 * be silently swallowed by graceful degradation.
 *
 * Enabled by default in vitest setupFiles. Tests that intentionally trigger
 * error logging can opt out per-test with `allowConsoleErrors()`.
 */

const SUSPICIOUS_PATTERNS = [
  'CRITICAL',
  'FOREIGN KEY',
  'No trace found',
  'mount failure',
  'unmount failure',
  'DB persistence failed',
  'constraint failed',
];

let capturedErrors: string[] = [];
let capturedWarnings: string[] = [];
let errorsAllowed = false;

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

/**
 * Call this at the start of a test that intentionally triggers error logging.
 * Suppresses strict checking for that test only.
 */
export function allowConsoleErrors(): void {
  errorsAllowed = true;
}

beforeEach(() => {
  capturedErrors = [];
  capturedWarnings = [];
  errorsAllowed = false;

  console.error = (...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    capturedErrors.push(msg);
    // Still print to stderr for debugging
    originalConsoleError.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    const msg = args.map(String).join(' ');
    capturedWarnings.push(msg);
    originalConsoleWarn.apply(console, args);
  };
});

afterEach(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;

  if (errorsAllowed) return;

  const allMessages = [...capturedErrors, ...capturedWarnings];
  const violations = allMessages.filter((msg) =>
    SUSPICIOUS_PATTERNS.some((pattern) => msg.includes(pattern)),
  );

  if (violations.length > 0) {
    expect.fail(
      `Strict test harness: ${violations.length} internal error(s) detected during test:\n` +
      violations.map((v) => `  • ${v.slice(0, 200)}`).join('\n') +
      '\n\nIf this is intentional, call allowConsoleErrors() at the start of the test.',
    );
  }
});
