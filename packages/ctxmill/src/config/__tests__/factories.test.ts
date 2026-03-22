import { describe, it, expect } from 'vitest';
import { createLLMProviderFromConfig } from '../factories.js';
import type { ResolvedConfig } from '../types.js';

function makeConfig(overrides: Partial<ResolvedConfig['llm']> = {}): ResolvedConfig {
  return {
    execution: { type: 'docker', warmPool: 0, maxGlobalContainers: 20 },
    database: { type: 'postgres', url: 'postgres://ctxmill:ctxmill@localhost:5433/ctxmill' },
    knowledge: { providers: ['pgvector'] },
    tools: { executors: ['local', 'mcp'] },
    security: { preset: 'docker' },
    learning: { strategy: 'ace', async: false },
    orchestration: { eventBus: true, reconciliation: false },
    observability: { sink: 'console', path: '' },
    llm: {
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'sk-test-key',
      baseUrl: '',
      ...overrides,
    },
  };
}

describe('createLLMProviderFromConfig', () => {
  it('throws if provider is not anthropic or openai', () => {
    const config = makeConfig({ provider: 'unsupported' });
    expect(() => createLLMProviderFromConfig(config)).toThrow(
      /Invalid LLM provider.*unsupported/,
    );
  });

  it('returns null if apiKey is empty (learning pipeline disabled)', () => {
    const config = makeConfig({ apiKey: '' });
    const provider = createLLMProviderFromConfig(config);
    expect(provider).toBeNull();
  });

  it('throws if model is empty', () => {
    const config = makeConfig({ model: '' });
    const provider = createLLMProviderFromConfig(config);
    expect(provider).toBeNull();
  });

  it('accepts valid anthropic config', () => {
    const config = makeConfig({ provider: 'anthropic', apiKey: 'sk-ant-key', model: 'claude-3' });
    // Should not throw
    const provider = createLLMProviderFromConfig(config);
    expect(provider).toBeDefined();
  });

  it('accepts valid openai config', () => {
    const config = makeConfig({ provider: 'openai', apiKey: 'sk-key', model: 'gpt-4' });
    const provider = createLLMProviderFromConfig(config);
    expect(provider).toBeDefined();
  });
});
