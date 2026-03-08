import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveConfig } from '../../packages/ctxmill/src/config/resolve.js';
import { presets } from '../../packages/ctxmill/src/config/presets.js';

describe('Config Resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Isolate environment for each test
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

  // CFG-01: preset 'local' resolves all defaults
  describe('CFG-01: local preset defaults', () => {
    it('should resolve database.type to sqlite', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.database.type).toBe('sqlite');
    });

    it('should resolve database.path to .ctxmill/data.db', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.database.path).toBe('.ctxmill/data.db');
    });

    it('should resolve execution.type to local', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.execution.type).toBe('local');
    });

    it('should resolve knowledge providers to memory', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.knowledge.providers).toEqual(['memory']);
    });

    it('should resolve learning strategy to simple', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.learning.strategy).toBe('simple');
      expect(config.learning.async).toBe(false);
    });

    it('should resolve observability sink to file', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.observability.sink).toBe('file');
      expect(config.observability.path).toBe('.ctxmill/audit.ndjson');
    });

    it('should resolve orchestration with eventBus and reconciliation disabled', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.orchestration.eventBus).toBe(false);
      expect(config.orchestration.reconciliation).toBe(false);
    });

    it('should resolve LLM defaults', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.llm.provider).toBe('anthropic');
      expect(config.llm.model).toBe('claude-sonnet-4-6');
    });

    it('should resolve tools executors to local', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.tools.executors).toEqual(['local']);
    });

    it('should resolve security preset to local', () => {
      const config = resolveConfig({ preset: 'local' });
      expect(config.security.preset).toBe('local');
    });
  });

  // CFG-02: Override specific subsystem within preset
  describe('CFG-02: subsystem overrides', () => {
    it('should override database type while keeping other local defaults', () => {
      const config = resolveConfig({
        preset: 'local',
        database: { type: 'postgres', url: 'postgres://localhost/test' },
      });
      expect(config.database.type).toBe('postgres');
      expect(config.database.url).toBe('postgres://localhost/test');
      // Other sections remain at local defaults
      expect(config.execution.type).toBe('local');
      expect(config.learning.strategy).toBe('simple');
    });

    it('should override learning strategy within local preset', () => {
      const config = resolveConfig({
        preset: 'local',
        learning: { strategy: 'ace', async: true },
      });
      expect(config.learning.strategy).toBe('ace');
      expect(config.learning.async).toBe(true);
      // Other defaults preserved
      expect(config.database.type).toBe('sqlite');
    });

    it('should override LLM model within preset', () => {
      const config = resolveConfig({
        preset: 'local',
        llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
      });
      expect(config.llm.provider).toBe('openai');
      expect(config.llm.model).toBe('gpt-4o');
      expect(config.llm.apiKey).toBe('sk-test');
    });

    it('should override multiple subsystems simultaneously', () => {
      const config = resolveConfig({
        preset: 'local',
        execution: { type: 'docker', warmPool: 2 },
        orchestration: { eventBus: true, reconciliation: false },
      });
      expect(config.execution.type).toBe('docker');
      expect(config.execution.warmPool).toBe(2);
      expect(config.orchestration.eventBus).toBe(true);
      // Untouched sections keep defaults
      expect(config.database.type).toBe('sqlite');
    });

    it('should resolve env: references in database URL from environment', () => {
      process.env.DATABASE_URL = 'postgres://user:pass@db:5432/ctxmill';
      const config = resolveConfig({ preset: 'docker' });
      expect(config.database.url).toBe('postgres://user:pass@db:5432/ctxmill');
    });

    it('should resolve LLM apiKey from ANTHROPIC_API_KEY env var', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      const config = resolveConfig({ preset: 'local' });
      expect(config.llm.apiKey).toBe('sk-ant-test-key');
    });

    it('should resolve LLM apiKey from OPENAI_API_KEY env var as fallback', () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test-key';
      const config = resolveConfig({ preset: 'local' });
      expect(config.llm.apiKey).toBe('sk-openai-test-key');
    });

    it('should not mutate the preset object', () => {
      const before = JSON.parse(JSON.stringify(presets.local));
      resolveConfig({
        preset: 'local',
        database: { type: 'postgres', url: 'postgres://localhost/test' },
      });
      expect(presets.local.database.type).toBe(before.database.type);
    });
  });

  // CFG-08: Migrations run idempotently (tested at config level - no crash on double resolve)
  describe('CFG-08: idempotent resolution', () => {
    it('should produce identical results when resolved twice with the same input', () => {
      const input = { preset: 'local' as const };
      const first = resolveConfig(input);
      const second = resolveConfig(input);
      expect(first).toEqual(second);
    });

    it('should produce identical results for docker preset resolved twice', () => {
      process.env.DATABASE_URL = 'postgres://localhost/test';
      const first = resolveConfig({ preset: 'docker' });
      const second = resolveConfig({ preset: 'docker' });
      expect(first).toEqual(second);
    });
  });
});
