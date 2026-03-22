import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../packages/ctxmill/src/config/resolve.js';
import { presets } from '../../packages/ctxmill/src/config/presets.js';

describe('Config Resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    process.env.DATABASE_URL = 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill';
    process.env.OPENAI_API_KEY = 'sk-test-default';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('CFG-01: docker preset defaults', () => {
    it('should resolve database.type to postgres', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.database.type).toBe('postgres');
    });

    it('should resolve execution.type to docker', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.execution.type).toBe('docker');
    });

    it('should resolve knowledge providers to pgvector', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.knowledge.providers).toEqual(['pgvector']);
    });

    it('should resolve learning strategy to ace', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.learning.strategy).toBe('ace');
      expect(config.learning.async).toBe(false);
    });

    it('should resolve observability sink to postgres', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.observability.sink).toBe('postgres');
    });

    it('should resolve orchestration with eventBus enabled', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.orchestration.eventBus).toBe(true);
      expect(config.orchestration.reconciliation).toBe(false);
    });

    it('should resolve LLM provider without a default model', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.llm.provider).toBe('openai');
      expect(config.llm.model).toBe('');
    });

    it('should resolve tools executors to local and mcp', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.tools.executors).toEqual(['local', 'mcp']);
    });

    it('should resolve security preset to docker', () => {
      const config = resolveConfig({ preset: 'docker' });
      expect(config.security.preset).toBe('docker');
    });
  });

  describe('CFG-02: subsystem overrides', () => {
    it('should override database url while keeping other docker defaults', () => {
      const config = resolveConfig({
        preset: 'docker',
        database: { url: 'postgres://localhost/test' },
      });
      expect(config.database.type).toBe('postgres');
      expect(config.database.url).toBe('postgres://localhost/test');
      expect(config.execution.type).toBe('docker');
      expect(config.learning.strategy).toBe('ace');
    });

    it('should override learning strategy within docker preset', () => {
      const config = resolveConfig({
        preset: 'docker',
        learning: { strategy: 'simple', async: true },
      });
      expect(config.learning.strategy).toBe('simple');
      expect(config.learning.async).toBe(true);
      expect(config.database.type).toBe('postgres');
    });

    it('should override LLM model within preset', () => {
      const config = resolveConfig({
        preset: 'docker',
        llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
      });
      expect(config.llm.provider).toBe('openai');
      expect(config.llm.model).toBe('gpt-4o');
      expect(config.llm.apiKey).toBe('sk-test');
    });

    it('should override multiple subsystems simultaneously', () => {
      const config = resolveConfig({
        preset: 'docker',
        orchestration: { eventBus: false, reconciliation: true },
      });
      expect(config.orchestration.eventBus).toBe(false);
      expect(config.orchestration.reconciliation).toBe(true);
      expect(config.database.type).toBe('postgres');
    });

    it('should resolve env: references in database URL from environment', () => {
      process.env.DATABASE_URL = 'postgres://user:pass@db:5432/ctxmill';
      const config = resolveConfig({ preset: 'docker' });
      expect(config.database.url).toBe('postgres://user:pass@db:5432/ctxmill');
    });

    it('should resolve LLM apiKey from OPENAI_API_KEY env var', () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test-key';
      const config = resolveConfig({ preset: 'docker' });
      expect(config.llm.apiKey).toBe('sk-openai-test-key');
    });

    it('should not resolve LLM apiKey from ANTHROPIC_API_KEY (harnesses resolve their own keys)', () => {
      delete process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      const config = resolveConfig({ preset: 'docker' });
      expect(config.llm.apiKey).toBe('');
    });

    it('should not mutate the preset object', () => {
      const before = JSON.parse(JSON.stringify(presets.docker));
      resolveConfig({
        preset: 'docker',
        database: { url: 'postgres://localhost/test' },
      });
      expect(presets.docker.database.type).toBe(before.database.type);
    });

    it('should throw if DATABASE_URL is not set', () => {
      delete process.env.DATABASE_URL;
      expect(() => resolveConfig({
        preset: 'docker',
      })).toThrow(/database.url is required/);
    });
  });

  describe('CFG-08: idempotent resolution', () => {
    it('should produce identical results when resolved twice with the same input', () => {
      const input = { preset: 'docker' as const };
      const first = resolveConfig(input);
      const second = resolveConfig(input);
      expect(first).toEqual(second);
    });
  });
});
