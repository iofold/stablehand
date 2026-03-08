import { describe, it, expect, vi } from 'vitest';
import { createLLMProvider } from '../../packages/ctxmill/src/llm/factory.js';

// Mock the LangChainLLMProvider to avoid langchain dependency resolution
vi.mock('../../packages/ctxmill/src/llm/langchain.js', () => ({
  LangChainLLMProvider: vi.fn().mockImplementation((config: { provider: string }) => ({
    name: config.provider === 'anthropic' ? 'langchain-anthropic' : 'langchain-openai',
    invoke: vi.fn(),
    healthy: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn(),
  })),
}));

describe('createLLMProvider factory', () => {
  it('should create openai provider from config', () => {
    const provider = createLLMProvider({
      apiKey: 'test', model: 'gpt-4', provider: 'openai',
    });
    expect(provider.name).toBe('langchain-openai');
  });

  it('should create anthropic provider from config', () => {
    const provider = createLLMProvider({
      apiKey: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic',
    });
    expect(provider.name).toBe('langchain-anthropic');
  });

  it('should pass baseUrl when provided', () => {
    const provider = createLLMProvider({
      apiKey: 'test', model: 'gpt-4', provider: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
    });
    expect(provider.name).toBe('langchain-openai');
  });
});
