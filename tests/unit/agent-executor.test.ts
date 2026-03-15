import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { LLMProvider } from '../../packages/ctxmill/src/llm/types.js';
import { AgentExecutor, normalizeStreamTextDeltas } from '../../packages/ctxmill/src/agent/executor.js';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import type { KnowledgeStore } from '../../packages/ctxmill/src/knowledge/types.js';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';
import { LangGraphHarness } from '../../packages/ctxmill/src/harness/langgraph.js';
import { builtinToolNames } from '../../packages/ctxmill/src/tool/builtin/index.js';
import type { AgentDefinition } from '../../packages/ctxmill/src/types.js';

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
      'LangGraphHarness requires an LLMProvider that implements getChatModel()',
    );
  });

  it('should accept an optional InterruptManager', () => {
    const provider = createMockLLMProvider();
    const toolExecutor = new LocalFunctionExecutor();
    const knowledgeStore = createMockKnowledgeStore();

    const executor1 = new AgentExecutor(provider, toolExecutor, knowledgeStore);
    expect(executor1).toBeDefined();

    const im = new InterruptManager();
    const executor2 = new AgentExecutor(provider, toolExecutor, knowledgeStore, im);
    expect(executor2).toBeDefined();
    im.shutdown();
  });
});

describe('AgentExecutor tool filtering', () => {
  it('should only provide declared tools plus builtins to an agent', () => {
    const provider = createMockLLMProvider();
    const toolExecutor = new LocalFunctionExecutor();

    // Register three tools: tool-a, tool-b, and the builtin emit-event
    const dummySchema = z.object({ input: z.string() });
    toolExecutor.register({
      name: 'tool-a',
      description: 'Tool A',
      input: dummySchema,
      handler: async () => 'a',
    });
    toolExecutor.register({
      name: 'tool-b',
      description: 'Tool B',
      input: dummySchema,
      handler: async () => 'b',
    });
    toolExecutor.register({
      name: 'emit-event',
      description: 'Builtin emit event',
      input: dummySchema,
      handler: async () => 'emitted',
    });

    const knowledgeStore = createMockKnowledgeStore();

    // Access the LangGraphHarness's private buildLangChainTools via the harness
    const harness = new LangGraphHarness(provider, toolExecutor, knowledgeStore);

    const ctx = {
      agentId: 'test',
      conversationId: 'conv-1',
      workspaceDir: '/tmp',
      knowledge: {
        query: async () => ({ items: [] }),
      },
    };

    // Agent only declares tool-a; filter tools the same way AgentExecutor does
    const allToolDefs = toolExecutor.list();
    const declaredTools = new Set(['tool-a']);
    const filteredTools = allToolDefs.filter(
      (def: any) => declaredTools.has(def.name) || builtinToolNames.has(def.name),
    );

    // Access private method for unit testing on the harness
    const lcTools = (harness as any).buildLangChainTools(ctx, 'run-1', filteredTools);
    const toolNames = lcTools.map((t: any) => t.name);

    // Should include tool-a (declared) and emit-event (builtin)
    expect(toolNames).toContain('tool-a');
    expect(toolNames).toContain('emit-event');

    // Should NOT include tool-b (not declared and not builtin)
    expect(toolNames).not.toContain('tool-b');

    // Exactly 2 tools
    expect(toolNames).toHaveLength(2);
  });
});

describe('normalizeStreamTextDeltas', () => {
  it('returns plain string chunks unchanged', () => {
    expect(normalizeStreamTextDeltas('Hello world')).toEqual(['Hello world']);
  });

  it('extracts structured text blocks', () => {
    expect(
      normalizeStreamTextDeltas([
        { type: 'text', text: 'Portfolio: ' },
        { type: 'text_delta', text: 'AAPL 100 shares' },
      ]),
    ).toEqual(['Portfolio: ', 'AAPL 100 shares']);
  });

  it('ignores non-text blocks while preserving text blocks', () => {
    expect(
      normalizeStreamTextDeltas([
        { type: 'tool_use', name: 'get-portfolio' },
        { type: 'text', text: 'Done' },
        { type: 'image', source: 'ignored' },
      ]),
    ).toEqual(['Done']);
  });

  it('returns empty array for empty string', () => {
    expect(normalizeStreamTextDeltas('')).toEqual([]);
  });

  it('returns empty array for empty text block', () => {
    expect(normalizeStreamTextDeltas({ type: 'text', text: '' })).toEqual([]);
  });

  it('extracts delta field from text blocks', () => {
    expect(
      normalizeStreamTextDeltas({ type: 'text_delta', delta: 'streaming chunk' }),
    ).toEqual(['streaming chunk']);
  });

  it('extracts value field from text blocks', () => {
    expect(
      normalizeStreamTextDeltas({ type: 'text', value: 'from value' }),
    ).toEqual(['from value']);
  });

  it('extracts nested text content after tool use', () => {
    expect(
      normalizeStreamTextDeltas({
        type: 'message',
        content: [
          { type: 'text', text: 'Current portfolio loaded.' },
        ],
      }),
    ).toEqual(['Current portfolio loaded.']);
  });
});
