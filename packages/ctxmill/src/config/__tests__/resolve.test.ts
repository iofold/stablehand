import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../resolve.js';

describe('resolveConfig validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws if database URL resolves to empty string', () => {
    // All presets now require DATABASE_URL
    expect(() => resolveConfig({ preset: 'docker' })).toThrow(/database.*url/i);
  });

  it('throws if database URL still contains env: prefix', () => {
    // Simulate a case where the env var name itself is wrong
    expect(() =>
      resolveConfig({
        preset: 'docker',
        database: { url: 'env:NONEXISTENT_VAR' },
      }),
    ).toThrow(/database.*url/i);
  });

  it('throws for docker preset without DATABASE_URL', () => {
    expect(() => resolveConfig({ preset: 'docker' })).toThrow(/database.*url/i);
  });

});
