import { describe, it, expect, vi } from 'vitest';
import { LangChainLLMProvider } from '../../packages/ctxmill/src/llm/langchain.js';
import type { ChatModel } from '../../packages/ctxmill/src/llm/langchain.js';

// Mock the heavy LangChain constructors so they don't make real API calls,
// but still exercise the LangChainLLMProvider constructor branching logic.
vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content: 'openai response',
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
    }),
  })),
}));
vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({
    invoke: vi.fn().mockResolvedValue({
      content: 'anthropic response',
      usage_metadata: { input_tokens: 12, output_tokens: 8 },
    }),
  })),
}));

/**
 * Build a fake ChatModel stub that returns the given content string.
 */
function fakeChatModel(content: string): ChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({
      content,
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
    }),
  };
}

describe('LLMProvider swap', () => {
  it('swap from openai to anthropic is purely config-driven', () => {
    const openai = new LangChainLLMProvider(
      { apiKey: 'k', model: 'gpt-4', provider: 'openai' },
      fakeChatModel('openai'),
    );
    expect(openai.name).toBe('langchain-openai');

    const anthropic = new LangChainLLMProvider(
      { apiKey: 'k', model: 'claude-sonnet-4-6', provider: 'anthropic' },
      fakeChatModel('anthropic'),
    );
    expect(anthropic.name).toBe('langchain-anthropic');
  });

  it('both providers implement the same LLMProvider interface', async () => {
    const configs: Array<{ provider: 'openai' | 'anthropic'; model: string }> = [
      { provider: 'openai', model: 'gpt-4' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ];

    for (const cfg of configs) {
      const provider = new LangChainLLMProvider(
        { apiKey: 'k', ...cfg },
        fakeChatModel(`${cfg.provider} response`),
      );

      // Same interface shape regardless of provider
      expect(typeof provider.invoke).toBe('function');
      expect(typeof provider.healthy).toBe('function');
      expect(typeof provider.shutdown).toBe('function');
      expect(typeof provider.name).toBe('string');

      // invoke returns normalised LLMResponse
      const result = await provider.invoke('test prompt');
      expect(result.content).toBe(`${cfg.provider} response`);
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

      // healthy/shutdown work identically
      expect(await provider.healthy()).toBe(true);
      await expect(provider.shutdown()).resolves.toBeUndefined();
    }
  });

  it('getChatModel returns the underlying model for framework integration', () => {
    const model = fakeChatModel('test');
    const provider = new LangChainLLMProvider(
      { apiKey: 'k', model: 'm', provider: 'openai' },
      model,
    );
    expect(provider.getChatModel()).toBe(model);
  });

  it('baseUrl passthrough works for openai provider', () => {
    // With mocked constructors, creating a provider with baseUrl should not throw
    const provider = new LangChainLLMProvider({
      apiKey: 'k', model: 'm', provider: 'openai',
      baseUrl: 'https://gateway.example.com/v1',
    });
    expect(provider.name).toBe('langchain-openai');
  });

  it('baseUrl passthrough works for anthropic provider', () => {
    const provider = new LangChainLLMProvider({
      apiKey: 'k', model: 'm', provider: 'anthropic',
      baseUrl: 'https://gateway.example.com/v1',
    });
    expect(provider.name).toBe('langchain-anthropic');
  });
});
