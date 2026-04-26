import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeConversationMessage, useConversationStore } from '../conversation';
import { useInterruptStore } from '../interrupt';

function getStore() {
  return useConversationStore.getState();
}

function makeEvent(type: string, event: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, ...event };
}

async function flushStreamingContent(): Promise<void> {
  const frameIds = getScheduledFrameIds();
  for (const frameId of frameIds) {
    runAnimationFrame(frameId);
  }
  await Promise.resolve();
}

let nextFrameId = 1;
let scheduledFrames = new Map<number, FrameRequestCallback>();

function getScheduledFrameIds(): number[] {
  return Array.from(scheduledFrames.keys());
}

function runAnimationFrame(frameId: number): void {
  const callback = scheduledFrames.get(frameId);
  if (!callback) return;
  scheduledFrames.delete(frameId);
  callback(performance.now());
}

beforeEach(() => {
  nextFrameId = 1;
  scheduledFrames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    scheduledFrames.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
    scheduledFrames.delete(frameId);
  });
  useConversationStore.getState().reset();
  useInterruptStore.getState().clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conversation store', () => {
  it('addUserMessage appends a user message', () => {
    getStore().addUserMessage('hello');

    const { messages } = getStore();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('hello');
    expect(messages[0].id).toEqual(expect.any(String));
    expect(messages[0].createdAt).toEqual(expect.any(String));
  });

  it('addUserMessage appends multiple messages in order', () => {
    getStore().addUserMessage('first');
    getStore().addUserMessage('second');

    const { messages } = getStore();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toBe('second');
  });

  it('loadMessages replaces all messages and resets state', () => {
    getStore().addUserMessage('existing');
    const loaded = [
      { id: 'x1', role: 'assistant' as const, content: 'loaded', createdAt: '2026-01-01T00:00:00Z' },
    ];
    getStore().loadMessages(loaded);

    const state = getStore();
    expect(state.messages).toEqual([
      {
        id: 'x1',
        role: 'assistant',
        content: 'loaded',
        parts: [{ type: 'text', content: 'loaded' }],
        toolCallId: undefined,
        toolCalls: undefined,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(state.isStreaming).toBe(false);
    expect(state.streamingContent).toBe('');
    expect(state.committedMessageCount).toBe(0);
  });

  it('reset clears all state', () => {
    getStore().addUserMessage('test');
    getStore().reset();

    const state = getStore();
    expect(state.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
    expect(state.currentTurnId).toBeNull();
    expect(state.committedMessageCount).toBe(0);
  });

  it('ignores stale scheduled flush callbacks after reset and conversation switch', () => {
    const { handleSSEEvent, reset, setActiveConversation } = getStore();

    setActiveConversation('conv-a');
    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1', conversationId: 'conv-a' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant', turnId: 'r1', conversationId: 'conv-a' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'stale', turnId: 'r1', conversationId: 'conv-a' }));

    const [staleFrameId] = getScheduledFrameIds();

    reset();
    setActiveConversation('conv-b');
    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r2', conversationId: 'conv-b' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant', turnId: 'r2', conversationId: 'conv-b' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'fresh', turnId: 'r2', conversationId: 'conv-b' }));

    const frameIds = getScheduledFrameIds();
    expect(frameIds).toHaveLength(1);
    expect(frameIds).not.toContain(staleFrameId);

    runAnimationFrame(staleFrameId!);
    expect(getStore().streamingContent).toBe('');

    runAnimationFrame(frameIds[0]!);
    expect(getStore().streamingContent).toBe('fresh');
  });

  it('ignores streaming deltas when no run is active or when they target a different turn', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'ignored while idle' }));
    await flushStreamingContent();

    expect(getStore().streamingContent).toBe('');

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r2' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'stale', turnId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'fresh', turnId: 'r2' }));

    await flushStreamingContent();

    expect(getStore().streamingContent).toBe('fresh');
  });

  it('sets streaming state on TURN_PENDING', () => {
    getStore().handleSSEEvent(makeEvent('TURN_PENDING', { runId: 'turn-1', timestamp: Date.now() }));

    expect(getStore().isStreaming).toBe(true);
    expect(getStore().currentTurnId).toBe('turn-1');
    expect(getStore().committedMessageCount).toBe(0);
  });

  it('RUN_STARTED sets streaming state', () => {
    getStore().handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'run-1' }));

    const state = getStore();
    expect(state.isStreaming).toBe(true);
    expect(state.currentTurnId).toBe('run-1');
  });

  it('state_snapshot restores streaming state using the active turn id instead of sandbox session id', () => {
    const { setActiveConversation, handleSSEEvent } = getStore();

    setActiveConversation('conv-1');
    handleSSEEvent(makeEvent('CUSTOM', {
      subtype: 'state_snapshot',
      conversationId: 'conv-1',
      sessionId: 'sandbox-session-1',
      activeTurnId: 'turn-1',
      turnId: 'turn-1',
      status: 'ACTIVE',
    }));

    const state = getStore();
    expect(state.isStreaming).toBe(true);
    expect(state.currentTurnId).toBe('turn-1');
  });

  it('state_snapshot does not mark an idle active container as streaming', () => {
    const { setActiveConversation, handleSSEEvent } = getStore();

    setActiveConversation('conv-1');
    handleSSEEvent(makeEvent('CUSTOM', {
      subtype: 'state_snapshot',
      conversationId: 'conv-1',
      sessionId: 'sandbox-session-1',
      activeTurnId: null,
      status: 'ACTIVE',
    }));

    const state = getStore();
    expect(state.isStreaming).toBe(false);
    expect(state.currentTurnId).toBeNull();
  });

  it('HITL_PAUSE forwards the pending interrupt payload to the interrupt store', () => {
    getStore().handleSSEEvent(makeEvent('HITL_PAUSE', {
      agentId: 'agent-1',
      runId: 'turn-1',
      toolName: 'search',
      toolCallId: 'tc-1',
      args: { q: 'ctxmill' },
    }));

    expect(useInterruptStore.getState().pending).toEqual({
      agentId: 'agent-1',
      sessionId: 'turn-1',
      toolName: 'search',
      toolCallId: 'tc-1',
      args: { q: 'ctxmill' },
    });
  });

  it('MESSAGE_COMMITTED creates a message with text content', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'Hello ' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'world' }));

    await flushStreamingContent();

    expect(getStore().streamingContent).toBe('Hello world');
    expect(getStore().messages).toHaveLength(0);

    handleSSEEvent(makeEvent('TEXT_MESSAGE_END'));

    expect(getStore().streamingContent).toBe('Hello world');
    expect(getStore().messages).toHaveLength(0);

    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: 'Hello world',
      messageSeq: 1,
      messageId: 'persisted-message-1',
      turnId: 'r1',
    }));

    const state = getStore();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe('persisted-message-1');
    expect(state.messages[0].role).toBe('assistant');
    expect(state.messages[0].content).toBe('Hello world');
    expect(state.messages[0].parts).toEqual([{ type: 'text', content: 'Hello world' }]);
    expect(state.streamingContent).toBe('');
    expect(state.committedMessageCount).toBe(1);
  });

  it('skips user message echoes', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'user' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'echo' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_END'));

    expect(getStore().messages).toHaveLength(0);
    expect(getStore().streamingContent).toBe('');
  });

  it('streaming tool events update preview state only', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', name: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', args: '{"q":"test"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_END', { toolCallId: 'tc1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'found it' }));

    const state = getStore();
    expect(state.messages).toHaveLength(0);
    expect(state.toolCalls.size).toBe(1);
    expect(state.toolCalls.get('tc1')).toEqual({
      id: 'tc1',
      name: 'search',
      args: '{"q":"test"}',
      result: 'found it',
      error: undefined,
      status: 'complete',
    });
  });

  it('MESSAGE_COMMITTED creates a message with tool calls merged from preview state', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', name: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', args: '{"q":"ctxmill"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'done' }));
    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'search', args: '', status: 'running' },
      ],
      messageSeq: 1,
      turnId: 'r1',
    }));

    const state = getStore();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].toolCalls).toEqual([
      {
        id: 'tc1',
        name: 'search',
        args: '{"q":"ctxmill"}',
        result: 'done',
        error: undefined,
        status: 'complete',
      },
    ]);
    expect(state.toolCalls.size).toBe(0);
  });

  it('full tool-call flow produces one committed message with merged result', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', name: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', args: '{"q":"test"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_END', { toolCallId: 'tc1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'found it' }));

    expect(getStore().messages).toHaveLength(0);

    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'search', args: '{"q":"test"}', status: 'running' },
      ],
      messageSeq: 1,
      turnId: 'r1',
    }));

    const state = getStore();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'tc1',
        name: 'search',
        args: '{"q":"test"}',
        result: 'found it',
        error: undefined,
        status: 'complete',
      },
    ]);
  });

  it('full text flow creates a single committed message', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'partial' }));

    await flushStreamingContent();

    handleSSEEvent(makeEvent('TEXT_MESSAGE_END'));

    expect(getStore().messages).toHaveLength(0);
    expect(getStore().streamingContent).toBe('partial');

    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: 'partial',
      messageSeq: 1,
      turnId: 'r1',
    }));

    expect(getStore().messages).toHaveLength(1);
    expect(getStore().messages[0].content).toBe('partial');
  });

  it('mixed text and tool-call flow creates a single committed message', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'Using a tool' }));

    await flushStreamingContent();

    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', name: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', args: '{"q":"ctxmill"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'result payload' }));
    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: 'Using a tool',
      parts: [
        { type: 'text', content: 'Using a tool' },
      ],
      toolCalls: [
        { id: 'tc1', name: 'search', args: '{"q":"ctxmill"}', status: 'running' },
      ],
      messageSeq: 1,
      turnId: 'r1',
    }));

    const state = getStore();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].parts).toEqual([
      { type: 'text', content: 'Using a tool' },
      {
        type: 'tool_call',
        id: 'tc1',
        name: 'search',
        args: '{"q":"ctxmill"}',
        result: 'result payload',
        error: undefined,
        status: 'complete',
      },
    ]);
  });

  it('supports multiple committed messages in one turn without duplicates', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('TURN_PENDING', { runId: 'r1' }));
    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: 'first',
      messageSeq: 1,
      turnId: 'r1',
    }));

    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'second' }));

    await flushStreamingContent();

    handleSSEEvent(makeEvent('TEXT_MESSAGE_END'));
    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: 'second',
      messageSeq: 2,
      turnId: 'r1',
    }));

    const state = getStore();
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => message.content)).toEqual(['first', 'second']);
    expect(state.committedMessageCount).toBe(2);
  });

  it('RUN_FINISHED clears preview state when MESSAGE_COMMITTED never arrives', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { content: 'partial' }));

    await flushStreamingContent();

    handleSSEEvent(makeEvent('RUN_FINISHED'));

    const state = getStore();
    expect(state.isStreaming).toBe(false);
    expect(state.currentTurnId).toBeNull();
    expect(state.streamingContent).toBe('');
    expect(state.messages).toHaveLength(0);
  });

  it('RUN_FINISHED drops uncommitted tool preview state instead of materializing a message', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', name: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', args: '{"q":"ctxmill"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'done' }));

    handleSSEEvent(makeEvent('RUN_FINISHED'));

    const state = getStore();
    expect(state.isStreaming).toBe(false);
    expect(state.currentTurnId).toBeNull();
    expect(state.toolCalls.size).toBe(0);
    expect(state.messages).toHaveLength(0);
  });

  it('RUN_FINISHED is a no-op after canonical commit with no pending preview state', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: 'done',
      messageSeq: 1,
      turnId: 'r1',
    }));
    handleSSEEvent(makeEvent('RUN_FINISHED'));

    const state = getStore();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('done');
    expect(state.isStreaming).toBe(false);
  });

  it('TOOL_CALL_RESULT with error updates preview state and commits as error later', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', name: 'fail' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: '', error: 'boom' }));

    expect(getStore().messages).toHaveLength(0);
    expect(getStore().toolCalls.get('tc1')).toEqual({
      id: 'tc1',
      name: 'fail',
      args: '',
      result: '',
      error: 'boom',
      status: 'error',
    });

    handleSSEEvent(makeEvent('MESSAGE_COMMITTED', {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'fail', args: '', status: 'running' },
      ],
      messageSeq: 1,
      turnId: 'r1',
    }));

    const committed = getStore().messages[0].toolCalls?.[0];
    expect(committed?.status).toBe('error');
    expect(committed?.error).toBe('boom');
  });

  it('RUN_ERROR adds system error message and stops streaming', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('RUN_ERROR', { message: 'Something broke' }));

    const state = getStore();
    expect(state.isStreaming).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('system');
    expect(state.messages[0].content).toContain('Something broke');
  });

  it('normalizeConversationMessage adapts persisted backend toolCalls shape', () => {
    const message = normalizeConversationMessage({
      id: 'm2',
      role: 'assistant',
      content: '',
      createdAt: 1710000000000,
      toolCalls: [
        {
          id: 'tc-1',
          name: 'search',
          arguments: { query: 'ctxmill' },
        },
        {
          id: 'tc-2',
          toolName: 'write_file',
          argumentsJson: '{"path":"/tmp/out.txt"}',
          error: 'permission denied',
          status: 'failed',
        },
      ],
    }, 'fallback');

    expect(message.createdAt).toBe(new Date(1710000000000).toISOString());
    expect(message.toolCalls).toEqual([
      {
        id: 'tc-1',
        name: 'search',
        args: '{"query":"ctxmill"}',
        result: undefined,
        error: undefined,
        status: 'complete',
      },
      {
        id: 'tc-2',
        name: 'write_file',
        args: '{"path":"/tmp/out.txt"}',
        result: undefined,
        error: 'permission denied',
        status: 'error',
      },
    ]);
  });

  it('normalizeConversationMessage preserves toolCallId for tool-role messages', () => {
    const message = normalizeConversationMessage({
      id: 'm3',
      role: 'tool',
      toolCallId: 'tc-9',
      content: 'done',
    }, 'fallback');

    expect(message.role).toBe('tool');
    expect(message.toolCallId).toBe('tc-9');
    expect(message.content).toBe('done');
  });
});
