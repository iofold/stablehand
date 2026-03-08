import { describe, it, expect } from 'vitest';
import type { LLMProvider } from '../../packages/ctxmill/src/llm/types.js';
import { AgentExecutor } from '../../packages/ctxmill/src/agent/executor.js';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import type { KnowledgeStore } from '../../packages/ctxmill/src/knowledge/types.js';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';

function createMockKnowledgeStore(): KnowledgeStore {
  return {
    name: 'mock-knowledge',
    async add() { return 'k1'; },
    async list() { return []; },
    async remove() {},
    async render() { return ''; },
    async healthy() { return true; },
    async shutdown() {},
  };
}

function createMockLLMProvider(opts?: { withChatModel?: boolean }): LLMProvider {
  const base: LLMProvider = {
    name: 'mock-llm',
    async invoke(prompt: string) {
      return { content: `echo: ${prompt}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async healthy() { return true; },
    async shutdown() {},
  };

  if (opts?.withChatModel !== false) {
    base.getChatModel = () => ({ invoke: async () => ({ content: 'hi' }) });
  }

  return base;
}

describe('AgentExecutor', () => {
  it('should construct with an LLMProvider that has getChatModel()', () => {
    const provider = createMockLLMProvider();
    const toolExecutor = new LocalFunctionExecutor();
    const knowledgeStore = createMockKnowledgeStore();

    const executor = new AgentExecutor(provider, toolExecutor, knowledgeStore);
    expect(executor).toBeDefined();
  });

  it('should throw if LLMProvider lacks getChatModel()', () => {
    const provider = createMockLLMProvider({ withChatModel: false });
    delete (provider as any).getChatModel;
    const toolExecutor = new LocalFunctionExecutor();
    const knowledgeStore = createMockKnowledgeStore();

    expect(() => new AgentExecutor(provider, toolExecutor, knowledgeStore)).toThrow(
      'AgentExecutor requires an LLMProvider that implements getChatModel()',
    );
  });

  it('should accept an optional InterruptManager', () => {
    const provider = createMockLLMProvider();
    const toolExecutor = new LocalFunctionExecutor();
    const knowledgeStore = createMockKnowledgeStore();

    // Without InterruptManager (backward compat)
    const executor1 = new AgentExecutor(provider, toolExecutor, knowledgeStore);
    expect(executor1).toBeDefined();

    // With InterruptManager
    const im = new InterruptManager();
    const executor2 = new AgentExecutor(provider, toolExecutor, knowledgeStore, im);
    expect(executor2).toBeDefined();
    im.shutdown();
  });
});
