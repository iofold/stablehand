import { describe, it, expect, vi } from 'vitest';
import { LangChainLLMProvider } from '../../packages/ctxmill/src/llm/langchain.js';
import type { ChatModel } from '../../packages/ctxmill/src/llm/langchain.js';

function createMockModel(): ChatModel {
  return {
    invoke: vi.fn().mockResolvedValue({
      content: 'mocked response',
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
    }),
  };
}

describe('LangChainLLMProvider', () => {
  it('should create an OpenAI provider', () => {
    const provider = new LangChainLLMProvider(
      { apiKey: 'test-key', model: 'gpt-4', provider: 'openai' },
      createMockModel(),
    );
    expect(provider.name).toBe('langchain-openai');
  });

  it('should create an Anthropic provider', () => {
    const provider = new LangChainLLMProvider(
      { apiKey: 'test-key', model: 'claude-sonnet-4-6', provider: 'anthropic' },
      createMockModel(),
    );
    expect(provider.name).toBe('langchain-anthropic');
  });

  it('should invoke and return structured response', async () => {
    const provider = new LangChainLLMProvider(
      { apiKey: 'test-key', model: 'gpt-4', provider: 'openai' },
      createMockModel(),
    );
    const result = await provider.invoke('hello');
    expect(result.content).toBe('mocked response');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  it('should report healthy', async () => {
    const provider = new LangChainLLMProvider(
      { apiKey: 'test-key', model: 'gpt-4', provider: 'openai' },
      createMockModel(),
    );
    expect(await provider.healthy()).toBe(true);
  });
});
