import { describe, expect, it } from 'vitest';
import { resolveTestDatabaseUrl } from '../utils/test-db.js';

const DEV1_URL = 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill';
const SAFE_URL = 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill_test';

describe('test database fail-closed guard (ctx-j9yl)', () => {
  it('throws when TEST_DATABASE_URL is unset', () => {
    expect(() => resolveTestDatabaseUrl({})).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it('refuses the dev1 runtime database without the destructive opt-in', () => {
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: DEV1_URL }))
      .toThrow(/dev1 runtime database/);
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: 'postgres://ctxmill:ctxmill@127.0.0.1:5433/ctxmill' }))
      .toThrow(/dev1 runtime database/);
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: 'postgres://ctxmill:ctxmill@postgres:5432/ctxmill' }))
      .toThrow(/dev1 runtime database/);
  });

  it('allows the runtime database only with CTXMILL_TEST_ALLOW_RUNTIME_DB=1', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: DEV1_URL, CTXMILL_TEST_ALLOW_RUNTIME_DB: '1' }))
      .toBe(DEV1_URL);
    expect(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: DEV1_URL, CTXMILL_TEST_ALLOW_RUNTIME_DB: '0' }))
      .toThrow(/dev1 runtime database/);
  });

  it('allows a dedicated test database without the opt-in', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: SAFE_URL })).toBe(SAFE_URL);
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: 'postgres://u:p@ci-host:5432/ctxmill' }))
      .toBe('postgres://u:p@ci-host:5432/ctxmill');
  });

  it('treats an unparseable URL as non-runtime and lets the driver reject it', () => {
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: 'not-a-url' })).toBe('not-a-url');
  });
});
