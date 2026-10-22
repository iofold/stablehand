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
    expect(messages[0].createdAt).toEqual(expect.any(Number));
  });

  it('addUserMessage appends multiple messages in order', () => {
    getStore().addUserMessage('first');
    getStore().addUserMessage('second');

    const { messages } = getStore();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toBe('second');
  });

  it('discards only the rejected optimistic user message', () => {
    const firstId = getStore().addUserMessage('first');
    const rejectedId = getStore().addUserMessage('rejected');

    getStore().discardOptimisticUserMessage(rejectedId);

    expect(getStore().messages.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: firstId, content: 'first' },
    ]);
    expect(getStore().optimisticUserMessageIds).toEqual([firstId]);
  });

  it('loadMessages replaces all messages and resets state', () => {
    getStore().addUserMessage('existing');
    const loaded = [
      {
        id: 'x1',
        messageRevision: 0,
        role: 'assistant' as const,
        content: 'loaded',
        createdAt: 1_767_225_600_000,
      },
    ];
    getStore().loadMessages(loaded);

    const state = getStore();
    expect(state.messages).toEqual([
      {
        id: 'x1',
        messageRevision: 0,
        role: 'assistant',
        content: 'loaded',
        parts: [{ type: 'text', content: 'loaded' }],
        toolCallId: undefined,
        toolCalls: undefined,
        createdAt: 1_767_225_600_000,
      },
    ]);
    expect(state.isStreaming).toBe(false);
    expect(state.streamingContent).toBe('');
    expect(state.committedMessageCount).toBe(0);
  });

  it('merges REST revision baselines during streaming and ignores a replayed commit', () => {
    const { handleSSEEvent, loadMessages, reset } = getStore();
    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));

    loadMessages([{
      id: 'persisted-1',
      messageRevision: 2,
      role: 'assistant',
      content: 'Authoritative REST projection',
      parts: [{ type: 'text', content: 'Authoritative REST projection' }],
      createdAt: Date.now(),
    }]);
    expect(getStore().messageRevisions.get('persisted-1')).toBe(2);

    handleSSEEvent(makeEvent('CUSTOM', {
      name: 'stablehand.message.committed',
      messageId: 'persisted-1',
      messageSeq: 0,
      role: 'assistant',
      content: 'Older baseline',
      parts: [{ type: 'text', content: 'Older baseline' }],
      turnId: 'r1',
    }));

    expect(getStore().messages).toHaveLength(1);
    expect(getStore().messages[0].content).toBe('Authoritative REST projection');

    reset();
    expect(getStore().messages).toEqual([]);
    expect(getStore().messageRevisions.size).toBe(0);
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
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'stale', turnId: 'r1', conversationId: 'conv-a' }));

    const [staleFrameId] = getScheduledFrameIds();

    reset();
    setActiveConversation('conv-b');
    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r2', conversationId: 'conv-b' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant', turnId: 'r2', conversationId: 'conv-b' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'fresh', turnId: 'r2', conversationId: 'conv-b' }));

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

    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'ignored while idle' }));
    await flushStreamingContent();

    expect(getStore().streamingContent).toBe('');

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r2' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'stale', turnId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'fresh', turnId: 'r2' }));

    await flushStreamingContent();

    expect(getStore().streamingContent).toBe('fresh');
  });

  it('sets streaming state on stablehand.turn.pending', () => {
    getStore().handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.turn.pending', turnId: 'turn-1', timestamp: Date.now() }));

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

  it('sandbox session snapshot restores streaming state using the active turn id instead of sandbox session id', () => {
    const { setActiveConversation, handleSSEEvent } = getStore();

    setActiveConversation('conv-1');
    handleSSEEvent(makeEvent('CUSTOM', {
      name: 'stablehand.sandbox_session.snapshot',
      conversationId: 'conv-1',
      sandboxSessionId: 'sandbox-session-1',
      activeTurnId: 'turn-1',
      status: 'ACTIVE',
    }));

    const state = getStore();
    expect(state.isStreaming).toBe(true);
    expect(state.currentTurnId).toBe('turn-1');
  });

  it('sandbox session snapshot does not mark an idle active container as streaming', () => {
    const { setActiveConversation, handleSSEEvent } = getStore();

    setActiveConversation('conv-1');
    handleSSEEvent(makeEvent('CUSTOM', {
      name: 'stablehand.sandbox_session.snapshot',
      conversationId: 'conv-1',
      sandboxSessionId: 'sandbox-session-1',
      activeTurnId: null,
      status: 'ACTIVE',
    }));

    const state = getStore();
    expect(state.isStreaming).toBe(false);
    expect(state.currentTurnId).toBeNull();
  });

  it('stablehand.interrupt.requested forwards the pending interrupt payload to the interrupt store', () => {
    getStore().handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.interrupt.requested',
      agentId: 'agent-1',
      turnId: 'turn-1',
      interruptId: 'interrupt-1',
      toolName: 'search',
      toolCallId: 'tc-1',
      args: { q: 'stablehand' },
    }));

    expect(useInterruptStore.getState().pending).toEqual({
      agentId: 'agent-1',
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      toolName: 'search',
      toolCallId: 'tc-1',
      args: { q: 'stablehand' },
    });
  });

  it('stablehand.message.committed creates a message with text content', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'Hello ' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'world' }));

    await flushStreamingContent();

    expect(getStore().streamingContent).toBe('Hello world');
    expect(getStore().messages).toHaveLength(0);

    handleSSEEvent(makeEvent('TEXT_MESSAGE_END'));

    expect(getStore().streamingContent).toBe('Hello world');
    expect(getStore().messages).toHaveLength(0);

    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
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

  it('reconstructs a canonical user message from replayed echo frames', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', {
      messageId: 'canonical-user-1',
      role: 'user',
    }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', {
      messageId: 'canonical-user-1',
      delta: 'echo',
    }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_END', {
      messageId: 'canonical-user-1',
    }));

    expect(getStore().messages).toEqual([
      expect.objectContaining({
        id: 'canonical-user-1',
        role: 'user',
        content: 'echo',
      }),
    ]);
    expect(getStore().streamingContent).toBe('');
  });

  it('reconciles an optimistic user message without start-frame flicker or duplication', () => {
    const { addUserMessage, handleSSEEvent } = getStore();
    addUserMessage('keep this visible');

    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', {
      messageId: 'canonical-user-1',
      role: 'user',
    }));

    expect(getStore().messages).toEqual([
      expect.objectContaining({
        id: 'canonical-user-1',
        role: 'user',
        content: 'keep this visible',
      }),
    ]);

    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', {
      messageId: 'canonical-user-1',
      delta: 'keep this visible',
    }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_END', {
      messageId: 'canonical-user-1',
    }));

    expect(getStore().messages).toEqual([
      expect.objectContaining({
        id: 'canonical-user-1',
        role: 'user',
        content: 'keep this visible',
      }),
    ]);
  });

  it('streaming tool events update preview state only', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', delta: '{"q":"test"}' }));
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

  it('reads the AG-UI toolCallName field on TOOL_CALL_START', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolCallName: 'search' }));

    expect(getStore().toolCalls.get('tc1')?.name).toBe('search');
  });

  it('stablehand.message.committed creates a message with tool calls merged from preview state', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', delta: '{"q":"stablehand"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'done' }));
    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-tool-preview',
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
        args: '{"q":"stablehand"}',
        result: 'done',
        error: undefined,
        status: 'complete',
      },
    ]);
    expect(state.toolCalls.size).toBe(0);
  });

  it('keeps the streamed tool name when the committed row has no name recorded', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolCallName: 'write_todos' }));
    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-unnamed-tool',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc1', name: 'unknown', args: '{}', status: 'complete' }],
      messageSeq: 1,
      turnId: 'r1',
    }));

    expect(getStore().messages[0].toolCalls?.[0].name).toBe('write_todos');
  });

  it('late TOOL_CALL_RESULT updates committed tool calls after preview state is cleared', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', delta: '{"q":"stablehand"}' }));
    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-late-result',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'search', args: '{"q":"stablehand"}', status: 'running' },
      ],
      messageSeq: 1,
      turnId: 'r1',
    }));

    expect(getStore().toolCalls.size).toBe(0);

    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'done' }));
    handleSSEEvent(makeEvent('RUN_FINISHED'));

    const committed = getStore().messages[0];
    expect(committed.toolCalls).toEqual([
      {
        id: 'tc1',
        name: 'search',
        args: '{"q":"stablehand"}',
        result: 'done',
        error: undefined,
        status: 'complete',
      },
    ]);
    expect(committed.parts).toEqual([
      {
        type: 'tool_call',
        id: 'tc1',
        name: 'search',
        args: '{"q":"stablehand"}',
        result: 'done',
        error: undefined,
        status: 'complete',
      },
    ]);
  });

  it('keeps canonical tool outcomes and tool-message identity when a bounded raw result arrives later', () => {
    const { handleSSEEvent } = getStore();
    const canonicalResult = 'X'.repeat(700);
    const boundedRawResult = canonicalResult.slice(0, 500);

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', {
      toolCallId: 'tc1',
      toolName: 'bash',
    }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', {
      toolCallId: 'tc1',
      delta: '{"command":"print 700 characters"}',
    }));
    handleSSEEvent(makeEvent('CUSTOM', {
      name: 'stablehand.message.committed',
      messageId: 'assistant-tool-call',
      role: 'assistant',
      content: '',
      messageSeq: 0,
      turnId: 'r1',
      parts: [{
        type: 'tool_call',
        id: 'tc1',
        name: 'bash',
        args: '{"command":"print 700 characters"}',
        result: canonicalResult,
        status: 'complete',
      }],
      toolCalls: [{
        id: 'tc1',
        name: 'bash',
        args: '{"command":"print 700 characters"}',
        status: 'complete',
      }],
    }));
    handleSSEEvent(makeEvent('CUSTOM', {
      name: 'stablehand.message.committed',
      messageId: 'canonical-tool-result',
      role: 'tool',
      content: canonicalResult,
      toolCallId: 'tc1',
      messageSeq: 1,
      turnId: 'r1',
    }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', {
      toolCallId: 'tc1',
      result: boundedRawResult,
    }));

    const [assistantMessage, toolMessage] = getStore().messages;
    expect(assistantMessage.turnId).toBe('r1');
    expect(assistantMessage.messageSeq).toBe(0);
    expect(assistantMessage.parts?.[0]).toEqual(expect.objectContaining({
      type: 'tool_call',
      id: 'tc1',
      result: canonicalResult,
    }));
    expect(assistantMessage.toolCalls?.[0].result).toBe(canonicalResult);
    expect(toolMessage).toEqual(expect.objectContaining({
      turnId: 'r1',
      messageSeq: 1,
      role: 'tool',
      toolCallId: 'tc1',
      content: canonicalResult,
    }));
  });

  it('full tool-call flow produces one committed message with merged result', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', delta: '{"q":"test"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_END', { toolCallId: 'tc1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'found it' }));

    expect(getStore().messages).toHaveLength(0);

    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-tool-flow',
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
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'partial' }));

    await flushStreamingContent();

    handleSSEEvent(makeEvent('TEXT_MESSAGE_END'));

    expect(getStore().messages).toHaveLength(0);
    expect(getStore().streamingContent).toBe('partial');

    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-text-flow',
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
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'Using a tool' }));

    await flushStreamingContent();

    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', delta: '{"q":"stablehand"}' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'result payload' }));
    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-mixed-flow',
      role: 'assistant',
      content: 'Using a tool',
      parts: [
        { type: 'text', content: 'Using a tool' },
      ],
      toolCalls: [
        { id: 'tc1', name: 'search', args: '{"q":"stablehand"}', status: 'running' },
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
        args: '{"q":"stablehand"}',
        result: 'result payload',
        error: undefined,
        status: 'complete',
      },
    ]);
  });

  it('preserves authoritative ordered message updates through RUN_FINISHED', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc1', result: 'first result' }));
    const baselineCommit = makeEvent('CUSTOM', {
      name: 'stablehand.message.committed',
      messageId: 'message-tools',
      role: 'assistant',
      content: '',
      messageSeq: 0,
      turnId: 'r1',
      parts: [
        { type: 'tool_call', id: 'tc1', name: 'search', args: '', result: 'first result', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tc1', name: 'search', args: '', status: 'complete' },
      ],
    });
    handleSSEEvent(baselineCommit);
    handleSSEEvent(baselineCommit);

    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant', messageId: 'stream-2' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { messageId: 'stream-2', delta: 'Need one more check.' }));
    await flushStreamingContent();
    handleSSEEvent(makeEvent('TEXT_MESSAGE_END', { messageId: 'stream-2' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc2', toolName: 'lookup' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc2', result: 'second result' }));

    const revisionOne = makeEvent('CUSTOM', {
      name: 'stablehand.message.updated',
      messageId: 'message-tools',
      messageRevision: 1,
      role: 'assistant',
      content: '',
      messageSeq: 0,
      turnId: 'r1',
      parts: [
        { type: 'tool_call', id: 'tc1', name: 'search', args: '', result: 'first result', status: 'complete' },
        { type: 'text', content: 'Need one more check.' },
        { type: 'tool_call', id: 'tc2', name: 'lookup', args: '', result: 'second result', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tc1', name: 'search', args: '', status: 'complete' },
        { id: 'tc2', name: 'lookup', args: '', status: 'complete' },
      ],
    });
    handleSSEEvent(revisionOne);

    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant', messageId: 'stream-3' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { messageId: 'stream-3', delta: 'Final check.' }));
    await flushStreamingContent();
    handleSSEEvent(makeEvent('TEXT_MESSAGE_END', { messageId: 'stream-3' }));
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc3', toolName: 'read' }));
    handleSSEEvent(makeEvent('TOOL_CALL_RESULT', { toolCallId: 'tc3', result: 'third result' }));
    handleSSEEvent(makeEvent('CUSTOM', {
      name: 'stablehand.message.updated',
      messageId: 'message-tools',
      messageRevision: 2,
      role: 'assistant',
      content: '',
      messageSeq: 0,
      turnId: 'r1',
      parts: [
        { type: 'tool_call', id: 'tc1', name: 'search', args: '', result: 'first result', status: 'complete' },
        { type: 'text', content: 'Need one more check.' },
        { type: 'tool_call', id: 'tc2', name: 'lookup', args: '', result: 'second result', status: 'complete' },
        { type: 'text', content: 'Final check.' },
        { type: 'tool_call', id: 'tc3', name: 'read', args: '', result: 'third result', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tc1', name: 'search', args: '', status: 'complete' },
        { id: 'tc2', name: 'lookup', args: '', status: 'complete' },
        { id: 'tc3', name: 'read', args: '', status: 'complete' },
      ],
    }));
    handleSSEEvent(revisionOne);
    const finalCommit = makeEvent('CUSTOM', {
      name: 'stablehand.message.committed',
      messageId: 'message-final',
      role: 'assistant',
      content: 'Done.',
      messageSeq: 1,
      turnId: 'r1',
      parts: [{ type: 'text', content: 'Done.' }],
    });
    handleSSEEvent(finalCommit);
    handleSSEEvent(finalCommit);
    handleSSEEvent(makeEvent('RUN_FINISHED', { runId: 'r1' }));

    const state = getStore();
    expect(state.messages.map((message) => message.id)).toEqual(['message-tools', 'message-final']);
    expect(state.messages[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'tc1',
        name: 'search',
        args: '',
        result: 'first result',
        error: undefined,
        status: 'complete',
      },
      { type: 'text', content: 'Need one more check.' },
      {
        type: 'tool_call',
        id: 'tc2',
        name: 'lookup',
        args: '',
        result: 'second result',
        error: undefined,
        status: 'complete',
      },
      { type: 'text', content: 'Final check.' },
      {
        type: 'tool_call',
        id: 'tc3',
        name: 'read',
        args: '',
        result: 'third result',
        error: undefined,
        status: 'complete',
      },
    ]);
    expect(state.messages[0].toolCalls).toEqual([
      {
        id: 'tc1',
        name: 'search',
        args: '',
        result: 'first result',
        error: undefined,
        status: 'complete',
      },
      {
        id: 'tc2',
        name: 'lookup',
        args: '',
        result: 'second result',
        error: undefined,
        status: 'complete',
      },
      {
        id: 'tc3',
        name: 'read',
        args: '',
        result: 'third result',
        error: undefined,
        status: 'complete',
      },
    ]);
    expect(state.messageRevisions.get('message-tools')).toBe(2);
    expect(state.streamingContent).toBe('');
    expect(state.toolCalls.size).toBe(0);
  });

  it('supports multiple committed messages in one turn without duplicates', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.turn.pending', turnId: 'r1' }));
    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-first',
      role: 'assistant',
      content: 'first',
      messageSeq: 1,
      turnId: 'r1',
    }));

    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'second' }));

    await flushStreamingContent();

    handleSSEEvent(makeEvent('TEXT_MESSAGE_END'));
    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-second',
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

  it('RUN_FINISHED clears preview state when stablehand.message.committed never arrives', async () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_START', { role: 'assistant' }));
    handleSSEEvent(makeEvent('TEXT_MESSAGE_CONTENT', { delta: 'partial' }));

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
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'search' }));
    handleSSEEvent(makeEvent('TOOL_CALL_ARGS', { toolCallId: 'tc1', delta: '{"q":"stablehand"}' }));
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
    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-finished',
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
    handleSSEEvent(makeEvent('TOOL_CALL_START', { toolCallId: 'tc1', toolName: 'fail' }));
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

    handleSSEEvent(makeEvent('CUSTOM', { name: 'stablehand.message.committed',
      messageId: 'message-tool-error',
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
          arguments: { query: 'stablehand' },
        },
        {
          id: 'tc-2',
          name: 'write_file',
          argumentsJson: '{"path":"/tmp/out.txt"}',
          error: 'permission denied',
          status: 'failed',
        },
      ],
    }, 'fallback');

    expect(message.createdAt).toBe(1710000000000);
    expect(message.toolCalls).toEqual([
      {
        id: 'tc-1',
        name: 'search',
        args: '{"query":"stablehand"}',
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
  describe('reply complete before the turn closes', () => {
    function commitAssistant(messageId: string, extra: Record<string, unknown> = {}) {
      getStore().handleSSEEvent(makeEvent('CUSTOM', {
        name: 'stablehand.message.committed',
        messageId,
        role: 'assistant',
        content: 'All done.',
        messageSeq: 1,
        turnId: 'r1',
        ...extra,
      }));
    }

    it('marks the reply complete on a text-only commit and clears it on RUN_FINISHED', () => {
      getStore().handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
      commitAssistant('final-1');

      expect(getStore().isStreaming).toBe(true);
      expect(getStore().responseComplete).toBe(true);

      getStore().handleSSEEvent(makeEvent('RUN_FINISHED', { runId: 'r1' }));
      expect(getStore().isStreaming).toBe(false);
      expect(getStore().responseComplete).toBe(false);
    });

    it('does not treat a tool-carrying commit as the final reply', () => {
      getStore().handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
      commitAssistant('batch-1', {
        toolCalls: [{ id: 'tc1', name: 'Read', args: '{}', status: 'complete', result: 'ok' }],
      });

      expect(getStore().responseComplete).toBe(false);
    });

    it('drops back to working when the agent starts something new', () => {
      getStore().handleSSEEvent(makeEvent('RUN_STARTED', { runId: 'r1' }));
      commitAssistant('final-2');
      expect(getStore().responseComplete).toBe(true);

      getStore().handleSSEEvent(makeEvent('TOOL_CALL_START', { runId: 'r1', toolCallId: 'tc2', toolCallName: 'Bash' }));
      expect(getStore().responseComplete).toBe(false);
    });
  });
  describe('approval decisions in the transcript', () => {
    it('leaves approve and reject to the tool call, which records the decision', () => {
      getStore().handleSSEEvent(makeEvent('CUSTOM', {
        name: 'stablehand.interrupt.resolved',
        action: 'approve',
        turnId: 'turn-7',
      }));

      expect(getStore().messages).toHaveLength(0);
    });

    it('keeps a local log line inside its turn', () => {
      getStore().addSystemMessage('Note', 'turn-7');
      expect(getStore().messages[0].turnId).toBe('turn-7');
    });

    it('logs a timeout as a timeout, not a rejection', () => {
      getStore().handleSSEEvent(makeEvent('CUSTOM', {
        name: 'stablehand.interrupt.resolved',
        action: 'timeout',
        turnId: 'turn-8',
      }));

      const [message] = getStore().messages;
      expect(message.content).toBe('Approval request timed out');
      expect(message.turnId).toBe('turn-8');
    });
  });
});
