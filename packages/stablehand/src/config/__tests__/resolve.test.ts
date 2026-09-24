import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDatabaseUrl } from '../resolve.js';

describe('resolveDatabaseUrl validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws if database URL resolves to empty string', () => {
    expect(() => resolveDatabaseUrl()).toThrow(/database.*url/i);
  });

  it('throws if database URL still contains env: prefix', () => {
    expect(() =>
      resolveDatabaseUrl({
        database: { url: 'env:NONEXISTENT_VAR' },
      }),
    ).toThrow(/database.*url/i);
  });

  it('returns an explicit database URL without reading the environment', () => {
    expect(resolveDatabaseUrl({
      database: { url: 'postgres://localhost/direct' },
    })).toBe('postgres://localhost/direct');
  });

});
