import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock LangChain to avoid real API calls
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({ content: 'ok', usage_metadata: {} }),
  })),
}));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({ content: 'ok', usage_metadata: {} }),
  })),
}));

import { createKnowledgeStoreFromConfig, createLLMProviderFromConfig } from '../../packages/ctxmill/src/config/factories.js';
import { InMemoryKnowledgeStore } from '../../packages/ctxmill/src/knowledge/store.js';
import type { ResolvedConfig } from '../../packages/ctxmill/src/config/types.js';

function makeConfig(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    execution: { type: 'local', warmPool: 0 },
    database: { type: 'postgres', url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
    knowledge: { providers: ['memory'] },
    tools: { executors: [] },
    security: { preset: 'local' },
    learning: { strategy: 'simple', async: false },
    orchestration: { eventBus: false, reconciliation: false },
    observability: { sink: 'console', path: '' },
    llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key', baseUrl: '' },
    ...overrides,
  };
}

describe('createKnowledgeStoreFromConfig', () => {
  it('returns InMemoryKnowledgeStore for "memory" provider', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));
    const config = makeConfig({ knowledge: { providers: ['memory'] } });
    const store = createKnowledgeStoreFromConfig(config, dataDir);
    expect(store).toBeInstanceOf(InMemoryKnowledgeStore);
  });

  it('defaults to InMemoryKnowledgeStore when providers array is empty', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));
    const config = makeConfig({ knowledge: { providers: [] } });
    const store = createKnowledgeStoreFromConfig(config, dataDir);
    expect(store).toBeInstanceOf(InMemoryKnowledgeStore);
  });

  it('throws for unknown provider', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctxmill-test-'));
    const config = makeConfig({ knowledge: { providers: ['redis'] } });
    expect(() => createKnowledgeStoreFromConfig(config, dataDir)).toThrow(
      'Unknown knowledge provider: redis',
    );
  });
});

describe('createLLMProviderFromConfig', () => {
  it('returns an LLMProvider matching config', () => {
    const config = makeConfig({
      llm: { provider: 'openai', model: 'gpt-4', apiKey: 'test-key', baseUrl: '' },
    });
    const provider = createLLMProviderFromConfig(config);
    expect(provider).toBeDefined();
    expect(typeof provider.invoke).toBe('function');
    expect(provider.name).toBe('langchain-openai');
  });

  it('passes baseUrl through to provider when set', () => {
    const config = makeConfig({
      llm: {
        provider: 'openai',
        model: 'gpt-4',
        apiKey: 'test-key',
        baseUrl: 'https://custom.api.com/v1',
      },
    });
    const provider = createLLMProviderFromConfig(config);
    expect(provider).toBeDefined();
  });
});
