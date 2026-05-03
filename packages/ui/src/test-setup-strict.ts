import { afterEach, beforeEach, expect } from 'vitest';

/**
 * UI strict test harness — fails any test that calls console.error or
 * console.warn unless the test explicitly allows it.
 *
 * The mirror of `tests/setup-strict.ts` for the backend, scoped to the React
 * tree. Per ctx-0zk, React render warnings, missing keys, prop-type errors,
 * and accidental error-path logs MUST fail the test rather than passing
 * silently.
 *
 * Tests that intentionally exercise an error path can opt out per-test:
 *
 *   import { allowConsoleErrors } from '../test-setup-strict';
 *   it('renders the error fallback', () => {
 *     allowConsoleErrors();
 *     ...
 *   });
 *
 * Allowlisted patterns are reserved for known-noisy third-party output that
 * cannot be silenced upstream. Add only with an ADR or audit reference.
 */

const ALLOWED_PATTERNS: Array<RegExp> = [
  // Add ONLY with audit/ADR justification. The list MUST stay tiny.
];

let capturedErrors: string[] = [];
let capturedWarnings: string[] = [];
let errorsAllowed = false;

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function isAllowed(message: string): boolean {
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Call at the start of a test that intentionally produces console.error /
 * console.warn output. Suppresses the strict gate for that test only.
 */
export function allowConsoleErrors(): void {
  errorsAllowed = true;
}

beforeEach(() => {
  capturedErrors = [];
  capturedWarnings = [];
  errorsAllowed = false;

  console.error = (...args: unknown[]) => {
    const msg = args.map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg))).join(' ');
    capturedErrors.push(msg);
    originalConsoleError.apply(console, args);
  };

  console.warn = (...args: unknown[]) => {
    const msg = args.map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg))).join(' ');
    capturedWarnings.push(msg);
    originalConsoleWarn.apply(console, args);
  };
});

afterEach(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;

  if (errorsAllowed) return;

  const unexpected = [...capturedErrors, ...capturedWarnings].filter(
    (msg) => !isAllowed(msg),
  );

  if (unexpected.length > 0) {
    expect.fail(
      `[ctx-0zk] UI strict console gate detected ${unexpected.length} unexpected console.error/warn call(s):\n` +
        unexpected.map((line) => `  • ${line.slice(0, 300)}`).join('\n') +
        '\n\nIf this is intentional, call allowConsoleErrors() at the start of the test.',
    );
  }
});

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
