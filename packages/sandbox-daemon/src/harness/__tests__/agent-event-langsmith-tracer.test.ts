import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../types.js';
import { createAgentEventLangSmithTracer } from '../kit/index.js';

class FakeLangSmithClient {
  awaitPendingTraceBatches = vi.fn(async () => undefined);
}

class FakeRunTree {
  static runs: FakeRunTree[] = [];

  readonly children: FakeRunTree[] = [];
  readonly postRun = vi.fn(async () => undefined);
  readonly end = vi.fn(async (_outputs?: Record<string, unknown>) => undefined);
  readonly patchRun = vi.fn(async () => undefined);

  constructor(readonly config: Record<string, unknown>) {
    FakeRunTree.runs.push(this);
  }

  createChild(config: Record<string, unknown>): FakeRunTree {
    const child = new FakeRunTree(config);
    this.children.push(child);
    return child;
  }
}

describe('createAgentEventLangSmithTracer', () => {
  it('returns null when tracing is disabled', async () => {
    await expect(createAgentEventLangSmithTracer({
      enabled: false,
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      harnessName: 'langgraph',
      turnId: 'turn-1',
    })).resolves.toBeNull();
  });

  it('maps normalized AgentEvents into an agent-turn-llm-tool span tree', async () => {
    FakeRunTree.runs = [];
    const client = new FakeLangSmithClient();
    const tracer = await createAgentEventLangSmithTracer({
      enabled: true,
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      harnessName: 'langgraph',
      turnId: 'turn-1',
      langsmith: {
        RunTree: FakeRunTree,
        Client: class {
          constructor() {
            return client;
          }
        },
        projectName: 'ctxmill-test',
      },
    });

    expect(tracer).not.toBeNull();
    const events: AgentEvent[] = [
      { type: 'text_delta', content: 'Using search.' },
      { type: 'tool_call_start', id: 'tool-1', name: 'search', args: { query: 'ctxmill' } },
      { type: 'tool_call_end', id: 'tool-1', result: 'search result', durationMs: 12 },
      {
        type: 'message_committed',
        role: 'assistant',
        content: 'Using search.',
        turnId: 'turn-1',
        messageSeq: 0,
        toolCalls: [{
          id: 'tool-1',
          name: 'search',
          arguments: { query: 'ctxmill' },
        }],
      },
      { type: 'done', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 0.01 } },
    ];

    for (const event of events) {
      await tracer?.onEvent(event);
    }
    await tracer?.flush?.();

    const root = FakeRunTree.runs[0];
    expect(root.config).toEqual(expect.objectContaining({
      name: 'langgraph-agent-agent-1',
      run_type: 'chain',
      project_name: 'ctxmill-test',
      inputs: { agentId: 'agent-1', conversationId: 'conversation-1', harnessName: 'langgraph' },
    }));
    expect(root.postRun).toHaveBeenCalledTimes(1);

    const turn = root.children[0];
    expect(turn.config).toEqual(expect.objectContaining({
      name: 'langgraph-turn',
      run_type: 'chain',
      inputs: { turnId: 'turn-1' },
    }));

    const llm = turn.children.find((child) => child.config.run_type === 'llm');
    expect(llm?.config).toEqual(expect.objectContaining({
      name: 'llm-call',
      run_type: 'llm',
    }));
    expect(llm?.end).toHaveBeenCalledWith(expect.objectContaining({
      generations: [{ text: 'Using search.' }],
      toolCalls: [expect.objectContaining({ id: 'tool-1', name: 'search' })],
    }));

    const tool = turn.children.find((child) => child.config.run_type === 'tool');
    expect(tool?.config).toEqual(expect.objectContaining({
      name: 'search',
      run_type: 'tool',
      inputs: { args: { query: 'ctxmill' }, toolCallId: 'tool-1' },
    }));
    expect(tool?.end).toHaveBeenCalledWith({
      result: 'search result',
      durationMs: 12,
    });

    expect(turn.end).toHaveBeenCalledWith(expect.objectContaining({
      assistantText: 'Using search.',
      usage_metadata: {
        input_tokens: 2,
        output_tokens: 3,
        total_tokens: 5,
        cost: 0.01,
      },
    }));
    expect(root.end).toHaveBeenCalledWith({ status: 'completed' });
    expect(client.awaitPendingTraceBatches).toHaveBeenCalledTimes(1);
  });
});
