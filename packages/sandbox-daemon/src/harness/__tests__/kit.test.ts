import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentEvent, HarnessSession } from '../types.js';
import {
  TurnAccumulator,
  errorMessage,
  finalizeTurn,
  linkAbortSignal,
  linkTurnAbort,
  normalizeTokenUsage,
  parseHarnessConfig,
  requestToolApproval,
  resolveModelAuth,
  traceAgentEvents,
} from '../kit/index.js';

describe('harness adapter kit', () => {
  it('accumulates text and successful tool calls into one committed assistant message', () => {
    const accumulator = new TurnAccumulator({ turnId: 'turn-1' });

    expect(accumulator.appendText('Hello')).toEqual({ type: 'text_delta', content: 'Hello' });
    accumulator.recordToolStart({ id: 'tool-1', name: 'search', args: { query: 'stablehand' } });
    accumulator.recordToolEnd({ id: 'tool-1', result: 'search result' });
    accumulator.recordDone({ type: 'done', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });

    expect(accumulator.createMessageCommitted(4)).toEqual({
      type: 'message_committed',
      role: 'assistant',
      content: 'Hello',
      turnId: 'turn-1',
      messageSeq: 4,
      toolCalls: [{
        id: 'tool-1',
        name: 'search',
        arguments: { query: 'stablehand' },
        args: '{"query":"stablehand"}',
        status: 'complete',
      }],
    });
    expect(accumulator.doneEvent()).toEqual({
      type: 'done',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  it('marks accumulated tool calls as errors', () => {
    const accumulator = new TurnAccumulator({ turnId: 'turn-1' });

    accumulator.recordToolStart({ id: 'tool-1', name: 'search', args: { query: 'bad' } });
    accumulator.recordToolEnd({ id: 'tool-1', result: 'search failed', error: 'search failed' });

    expect(accumulator.createMessageCommitted(0)?.toolCalls?.[0]).toEqual({
      id: 'tool-1',
      name: 'search',
      arguments: { query: 'bad' },
      args: '{"query":"bad"}',
      status: 'error',
    });
  });

  it('does not create an empty assistant commit', () => {
    const accumulator = new TurnAccumulator({ turnId: 'turn-1' });

    expect(accumulator.createMessageCommitted(0)).toBeUndefined();
    expect(accumulator.hasCommitContent()).toBe(false);
  });

  it('can record assistant commit text without emitting a text delta', () => {
    const accumulator = new TurnAccumulator({ turnId: 'turn-1' });

    accumulator.recordAssistantText('terminal result');

    expect(accumulator.hasCommitContent()).toBe(true);
    expect(accumulator.createMessageCommitted(1)).toMatchObject({
      type: 'message_committed',
      content: 'terminal result',
      turnId: 'turn-1',
      messageSeq: 1,
    });
  });

  it('finalizes the transcript before emitting commit and done events', () => {
    const accumulator = new TurnAccumulator({ turnId: 'turn-1' });
    const transcript = [{
      id: 'message-1',
      agentId: 'agent-1',
      role: 'user' as const,
      content: 'Hello',
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
    }];
    accumulator.recordAssistantText('Hi');
    accumulator.recordDone({ type: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });

    expect([...finalizeTurn(accumulator, transcript, 'agent-1')]).toEqual([
      {
        type: 'message_committed',
        role: 'assistant',
        content: 'Hi',
        turnId: 'turn-1',
        messageSeq: 1,
      },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
    expect(transcript[1]).toMatchObject({
      agentId: 'agent-1',
      role: 'assistant',
      content: 'Hi',
    });
  });

  it('emits approval_needed and approval_resolved around approved tools', async () => {
    const events: AgentEvent[] = [];

    const result = await requestToolApproval({
      id: 'approval-1',
      turnId: 'turn-1',
      toolName: 'guarded_search',
      args: { query: 'stablehand' },
      onApprovalNeeded: vi.fn(async () => ({ action: 'approve' as const })),
      emit: (event) => events.push(event),
    });

    expect(result).toEqual({ approved: true });
    expect(events).toEqual([
      { type: 'approval_needed', id: 'approval-1', tool: 'guarded_search', args: { query: 'stablehand' } },
      { type: 'approval_resolved', id: 'approval-1', action: 'approve' },
    ]);
  });

  it('returns the canonical rejection message for rejected approvals', async () => {
    const events: AgentEvent[] = [];

    const result = await requestToolApproval({
      id: 'approval-1',
      turnId: 'turn-1',
      toolName: 'guarded_search',
      args: { query: 'blocked' },
      onApprovalNeeded: vi.fn(async () => ({ action: 'reject' as const })),
      emit: (event) => events.push(event),
    });

    expect(result).toEqual({
      approved: false,
      rejectionMessage: 'Tool call was rejected by the user.',
    });
    expect(events).toContainEqual({ type: 'approval_resolved', id: 'approval-1', action: 'reject' });
  });

  it('resolves model auth from explicit secret refs before provider defaults', () => {
    expect(resolveModelAuth({
      provider: 'google',
      apiKeyRef: '$secret:CUSTOM_GOOGLE_KEY',
      secrets: {
        CUSTOM_GOOGLE_KEY: 'secret-value',
        GOOGLE_API_KEY: 'provider-secret',
      },
      env: {
        CUSTOM_GOOGLE_KEY: 'env-value',
      },
    })).toEqual({
      provider: 'google',
      apiKey: 'secret-value',
      apiKeyEnvVar: 'GOOGLE_API_KEY',
    });
  });

  it('resolves provider default model auth from secrets and env aliases', () => {
    expect(resolveModelAuth({
      provider: 'google',
      secrets: {},
      env: {
        GEMINI_API_KEY: 'gemini-env',
      },
    })).toEqual({
      provider: 'google',
      apiKey: 'gemini-env',
      apiKeyEnvVar: 'GOOGLE_API_KEY',
    });
  });

  it('normalizes provider token usage shapes', () => {
    expect(normalizeTokenUsage({ input: 2, output: 3, totalTokens: 5, cost: { total: 0.25 } })).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      costUsd: 0.25,
    });
    expect(normalizeTokenUsage({ input_tokens: 4, output_tokens: 6 })).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
  });

  it('counts cache reads and writes as input when the provider reports them separately', () => {
    // Claude Agent SDK result usage (Anthropic API shape).
    expect(normalizeTokenUsage({
      input_tokens: 6,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 48000,
      output_tokens: 1586,
      cost: 0.0788,
    })).toEqual({
      inputTokens: 49206,
      outputTokens: 1586,
      totalTokens: 50792,
      costUsd: 0.0788,
    });
    // pi-ai: totalTokens already includes the cache counts.
    expect(normalizeTokenUsage({ input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135 })).toEqual({
      inputTokens: 130,
      outputTokens: 5,
      totalTokens: 135,
    });
    // LangChain usage_metadata folds cache into input_tokens already.
    expect(normalizeTokenUsage({
      input_tokens: 500,
      output_tokens: 20,
      total_tokens: 520,
      input_token_details: { cache_read: 400 },
    })).toEqual({ inputTokens: 500, outputTokens: 20, totalTokens: 520 });
  });

  it('links abort signals and returns a cleanup function', () => {
    const controller = new AbortController();
    const abort = vi.fn();

    const cleanup = linkAbortSignal(controller.signal, abort);
    controller.abort();
    cleanup();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('runs abort callback immediately when source signal is already aborted', () => {
    const controller = new AbortController();
    const abort = vi.fn();
    controller.abort();

    const cleanup = linkAbortSignal(controller.signal, abort);
    cleanup();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('links both turn abort sources with one cleanup', () => {
    const configController = new AbortController();
    const contextController = new AbortController();
    const abort = vi.fn();
    const cleanup = linkTurnAbort(configController.signal, contextController.signal, abort);

    configController.abort();
    cleanup();
    contextController.abort();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('parses harness config through its schema', () => {
    expect(parseHarnessConfig(z.object({ model: z.string() }), '{"model":"test"}')).toEqual({ model: 'test' });
    expect(() => parseHarnessConfig(z.object({ model: z.string() }), '{"model":1}')).toThrow();
  });

  it('normalizes error messages', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed');
    expect(errorMessage('failed')).toBe('failed');
  });

  it('traces normalized AgentEvents without changing the stream', async () => {
    const events: AgentEvent[] = [
      { type: 'text_delta', content: 'Hello' },
      {
        type: 'message_committed',
        role: 'assistant',
        content: 'Hello',
        turnId: 'turn-1',
        messageSeq: 0,
      },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    ];
    const tracedEvents: AgentEvent[] = [];
    const flush = vi.fn(async () => undefined);
    const traced = traceAgentEvents(makeHarnessSession(events), {
      createTracer: async () => ({
        onEvent: (event) => {
          tracedEvents.push(event);
        },
        flush,
      }),
    });

    await expect(collectEvents(traced.deliverTurn({ messages: [], turnId: 'turn-1' }, {})))
      .resolves.toEqual(events);
    expect(tracedEvents).toEqual(events);
    expect(flush).toHaveBeenCalledTimes(1);
    await expect(traced.exportState()).resolves.toEqual({ stateVersion: '2', payload: { ok: true } });
  });

  it('flushes the AgentEvent tracer when a consumer stops early', async () => {
    const flush = vi.fn(async () => undefined);
    const traced = traceAgentEvents(makeHarnessSession([
      { type: 'text_delta', content: 'first' },
      { type: 'text_delta', content: 'second' },
    ]), {
      createTracer: async () => ({
        onEvent: vi.fn(),
        flush,
      }),
    });

    const stream = traced.deliverTurn({ messages: [], turnId: 'turn-1' }, {});
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'text_delta', content: 'first' },
      done: false,
    });
    await stream.return(undefined);

    expect(flush).toHaveBeenCalledTimes(1);
  });
});

async function collectEvents(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function makeHarnessSession(events: AgentEvent[]): HarnessSession {
  return {
    async *deliverTurn() {
      for (const event of events) {
        yield event;
      }
    },
    async exportState() {
      return { stateVersion: '2', payload: { ok: true } };
    },
    async close() {},
  };
}
