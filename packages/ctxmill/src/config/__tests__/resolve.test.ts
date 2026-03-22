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

  it('throws if database URL resolves to empty string', () => {
    // All presets now require DATABASE_URL
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() => resolveConfig({ preset: 'docker' })).toThrow(/database.*url/i);
  });

  it('succeeds with empty llm.apiKey when no OPENAI_API_KEY set (learning pipeline disabled)', () => {
    process.env.DATABASE_URL = 'postgres://localhost/test';
    const config = resolveConfig({ preset: 'docker' });
    expect(config.llm.apiKey).toBe('');
  });

  it('succeeds with a valid OPENAI_API_KEY', () => {
    process.env.DATABASE_URL = 'postgres://localhost/test';
    process.env.OPENAI_API_KEY = 'sk-test-valid-key';
    const config = resolveConfig({ preset: 'docker' });
    expect(config.llm.apiKey).toBe('sk-test-valid-key');
  });

  it('does not use ANTHROPIC_API_KEY for global LLM config (harnesses resolve their own keys)', () => {
    process.env.DATABASE_URL = 'postgres://localhost/test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const config = resolveConfig({ preset: 'docker' });
    expect(config.llm.apiKey).toBe('');
  });

  it('throws if database URL still contains env: prefix', () => {
    // Simulate a case where the env var name itself is wrong
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() =>
      resolveConfig({
        preset: 'docker',
        database: { url: 'env:NONEXISTENT_VAR' },
      }),
    ).toThrow(/database.*url/i);
  });

  it('throws for docker preset without DATABASE_URL', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() => resolveConfig({ preset: 'docker' })).toThrow(/database.*url/i);
  });

});
