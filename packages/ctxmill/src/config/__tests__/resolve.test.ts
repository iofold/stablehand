import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../resolve.js';

describe('resolveConfig validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws if database URL resolves to empty string for non-local preset', () => {
    // docker preset expects env:DATABASE_URL but we haven't set it
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() => resolveConfig({ preset: 'docker' })).toThrow(/database.*url/i);
  });

  it('throws if no LLM API key is available', () => {
    // local preset, no API keys in env
    expect(() => resolveConfig({ preset: 'local' })).toThrow(/api.?key/i);
  });

  it('succeeds with a valid OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-test-valid-key';
    const config = resolveConfig({ preset: 'local' });
    expect(config.llm.apiKey).toBe('sk-test-valid-key');
  });

  it('succeeds with a valid ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const config = resolveConfig({ preset: 'local' });
    expect(config.llm.apiKey).toBe('sk-ant-test-key');
  });

  it('throws if database URL still contains env: prefix for non-local preset', () => {
    // Simulate a case where the env var name itself is wrong
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() =>
      resolveConfig({
        preset: 'docker',
        database: { type: 'postgres', url: 'env:NONEXISTENT_VAR' },
      }),
    ).toThrow(/database.*url/i);
  });

  it('does not throw for local preset with empty database URL', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    // local preset has url: '' which is fine
    const config = resolveConfig({ preset: 'local' });
    expect(config.database.url).toBe('');
  });
});
