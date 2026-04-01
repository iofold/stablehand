import { describe, it, expect } from 'vitest';
import type { LLMProvider } from '../../packages/ctxmill/src/llm/types.js';

describe('LLMProvider interface', () => {
  it('should allow a minimal implementation', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      async invoke(prompt: string) {
        return { content: `echo: ${prompt}`, usage: { inputTokens: 10, outputTokens: 5 } };
      },
      async healthy() { return true; },
      async shutdown() {},
    };

    const result = await provider.invoke('hello');
    expect(result.content).toBe('echo: hello');
    expect(result.usage.inputTokens).toBe(10);
    expect(await provider.healthy()).toBe(true);
  });

  it('should support streaming via invokeStream', async () => {
    const provider: LLMProvider = {
      name: 'mock-stream',
      async invoke(_prompt) {
        return { content: 'full', usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async *invokeStream(_prompt) {
        yield { content: 'hel', done: false };
        yield { content: 'lo', done: true };
      },
      async healthy() { return true; },
      async shutdown() {},
    };

    const chunks: string[] = [];
    for await (const chunk of provider.invokeStream!('hi')) {
      chunks.push(chunk.content);
    }
    expect(chunks).toEqual(['hel', 'lo']);
  });
});
