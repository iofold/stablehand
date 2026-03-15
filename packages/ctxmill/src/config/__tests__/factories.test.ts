import { describe, it, expect } from 'vitest';
import { createLLMProviderFromConfig } from '../factories.js';
import type { ResolvedConfig } from '../types.js';

function makeConfig(overrides: Partial<ResolvedConfig['llm']> = {}): ResolvedConfig {
  return {
    execution: { type: 'local', warmPool: 0 },
    database: { type: 'sqlite', path: ':memory:', url: '' },
    knowledge: { providers: ['memory'] },
    tools: { executors: [] },
    security: { preset: 'local' },
    learning: { strategy: 'simple', async: false },
    orchestration: { eventBus: false, reconciliation: false },
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

  it('throws if apiKey is empty', () => {
    const config = makeConfig({ apiKey: '' });
    expect(() => createLLMProviderFromConfig(config)).toThrow(/apiKey/);
  });

  it('throws if model is empty', () => {
    const config = makeConfig({ model: '' });
    expect(() => createLLMProviderFromConfig(config)).toThrow(/model/);
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
