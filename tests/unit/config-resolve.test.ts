import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDatabaseUrl } from '../../packages/ctxmill/src/config/resolve.js';

describe('Config Resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = 'postgres://config-test:config-test@config-test-host:5432/ctxmill_config_test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves DATABASE_URL by default', () => {
    expect(resolveDatabaseUrl()).toBe(process.env.DATABASE_URL);
  });

  it('prefers an explicit database URL from config', () => {
    expect(resolveDatabaseUrl({
      database: { url: 'postgres://localhost/explicit' },
    })).toBe('postgres://localhost/explicit');
  });

  it('resolves env: references from the named environment variable', () => {
    process.env.CTXMILL_TEST_DATABASE_URL = 'postgres://localhost/env-ref';
    expect(resolveDatabaseUrl({
      database: { url: 'env:CTXMILL_TEST_DATABASE_URL' },
    })).toBe('postgres://localhost/env-ref');
  });

  it('throws if the resolved database URL is empty', () => {
    delete process.env.DATABASE_URL;
    expect(() => resolveDatabaseUrl()).toThrow(/database.url is required/);
  });

});
