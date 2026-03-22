import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeConversationMessage, useConversationStore } from '../conversation';

function getStore() {
  return useConversationStore.getState();
}

beforeEach(() => {
  useConversationStore.getState().reset();
});

describe('conversation store', () => {
  // ── addUserMessage ─────────────────────────────────────────────

  it('addUserMessage appends a user message', () => {
    getStore().addUserMessage('hello');

    const { messages } = getStore();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('hello');
    expect(messages[0].id).toBeTruthy();
    expect(messages[0].createdAt).toBeTruthy();
  });

  it('addUserMessage appends multiple messages in order', () => {
    getStore().addUserMessage('first');
    getStore().addUserMessage('second');

    const { messages } = getStore();
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toBe('second');
  });

  // ── loadMessages ───────────────────────────────────────────────

  it('loadMessages replaces all messages and resets state', () => {
    getStore().addUserMessage('existing');
    const loaded = [
      { id: 'x1', role: 'assistant' as const, content: 'loaded', createdAt: '2026-01-01T00:00:00Z' },
    ];
    getStore().loadMessages(loaded);

    const state = getStore();
    expect(state.messages).toEqual(loaded);
    expect(state.isStreaming).toBe(false);
    expect(state.streamingContent).toBe('');
  });

  // ── reset ──────────────────────────────────────────────────────

  it('reset clears all state', () => {
    getStore().addUserMessage('test');
    getStore().reset();

    const state = getStore();
    expect(state.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
    expect(state.currentRunId).toBeNull();
  });

  // ── handleSSEEvent: RUN_STARTED ────────────────────────────────

  it('RUN_STARTED sets streaming state', () => {
    getStore().handleSSEEvent({ type: 'RUN_STARTED', runId: 'run-1' });

    const state = getStore();
    expect(state.isStreaming).toBe(true);
    expect(state.currentRunId).toBe('run-1');
  });

  // ── handleSSEEvent: TEXT_MESSAGE flow ──────────────────────────

  it('streams assistant text and finalizes on TEXT_MESSAGE_END', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_START', role: 'assistant' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_CONTENT', content: 'Hello ' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_CONTENT', content: 'world' });

    expect(getStore().streamingContent).toBe('Hello world');

    handleSSEEvent({ type: 'TEXT_MESSAGE_END' });

    const { messages, streamingContent } = getStore();
    expect(streamingContent).toBe('');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe('Hello world');
  });

  it('skips user message echoes (TEXT_MESSAGE_CONTENT with user role)', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_START', role: 'user' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_CONTENT', content: 'echo' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_END' });

    expect(getStore().messages).toHaveLength(0);
    expect(getStore().streamingContent).toBe('');
  });

  // ── handleSSEEvent: TOOL_CALL flow ─────────────────────────────

  it('tracks tool calls through start/args/end/result', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_START', role: 'assistant' });
    handleSSEEvent({ type: 'TOOL_CALL_START', toolCallId: 'tc1', name: 'search' });
    handleSSEEvent({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', args: '{"q":"test"}' });
    handleSSEEvent({ type: 'TOOL_CALL_END', toolCallId: 'tc1' });
    handleSSEEvent({ type: 'TOOL_CALL_RESULT', toolCallId: 'tc1', result: 'found it' });

    const tc = getStore().toolCalls.get('tc1');
    expect(tc).toBeDefined();
    expect(tc!.name).toBe('search');
    expect(tc!.args).toBe('{"q":"test"}');
    expect(tc!.result).toBe('found it');
    expect(tc!.status).toBe('complete');
  });

  it('tool calls are attached to message on TEXT_MESSAGE_END', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_START', role: 'assistant' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_CONTENT', content: 'result' });
    handleSSEEvent({ type: 'TOOL_CALL_START', toolCallId: 'tc1', name: 'search' });
    handleSSEEvent({ type: 'TOOL_CALL_END', toolCallId: 'tc1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_END' });

    const msg = getStore().messages[0];
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].name).toBe('search');
  });

  // ── handleSSEEvent: CUSTOM (a2ui) ─────────────────────────────

  it('handles CUSTOM a2ui events', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({
      type: 'CUSTOM',
      subtype: 'a2ui',
      id: 'b1',
      payload: { component: 'ctxmill.charts:MetricCard', props: { title: 'Users', value: 12 } },
    });

    expect(getStore().a2uiBlocks).toHaveLength(1);
    expect(getStore().a2uiBlocks[0].component).toBe('MetricCard');
  });

  // ── handleSSEEvent: RUN_FINISHED ───────────────────────────────

  it('RUN_FINISHED finalizes remaining streaming content', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_START', role: 'assistant' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_CONTENT', content: 'partial' });
    // No TEXT_MESSAGE_END — go straight to RUN_FINISHED
    handleSSEEvent({ type: 'RUN_FINISHED' });

    const state = getStore();
    expect(state.isStreaming).toBe(false);
    expect(state.currentRunId).toBeNull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('partial');
  });

  it('RUN_FINISHED preserves pending A2UI blocks', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_START', role: 'assistant' });
    handleSSEEvent({
      type: 'CUSTOM',
      subtype: 'a2ui',
      id: 'b1',
      payload: { component: 'ctxmill.hitl:ApprovalCard', props: { title: 'Approve', description: 'Review', action: 'deploy' } },
    });
    handleSSEEvent({ type: 'RUN_FINISHED' });

    const state = getStore();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].a2uiBlocks).toHaveLength(1);
    expect(state.messages[0].a2uiBlocks?.[0].component).toBe('ApprovalCard');
  });

  it('RUN_FINISHED with no streaming content does not add empty message', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'RUN_FINISHED' });

    expect(getStore().messages).toHaveLength(0);
    expect(getStore().isStreaming).toBe(false);
  });

  // ── handleSSEEvent: RUN_ERROR ──────────────────────────────────

  it('RUN_ERROR adds system error message and stops streaming', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'RUN_ERROR', message: 'Something broke' });

    const state = getStore();
    expect(state.isStreaming).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('system');
    expect(state.messages[0].content).toContain('Something broke');
  });

  it('normalizeConversationMessage uses stored A2UI payload and canonicalizes names', () => {
    const message = normalizeConversationMessage({
      id: 'm1',
      role: 'assistant',
      content: 'hello',
      a2uiPayload: [
        { component: 'ctxmill.charts:MetricCard', props: { title: 'Users', value: 42 } },
      ],
    }, 'fallback');

    expect(message.a2uiBlocks).toHaveLength(1);
    expect(message.a2uiBlocks?.[0].component).toBe('MetricCard');
    expect(message.a2uiBlocks?.[0].id).toBe('m1-a2ui-0');
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

  // ── handleSSEEvent: TOOL_CALL_RESULT with error ────────────────

  it('TOOL_CALL_RESULT with error marks tool as error status', () => {
    const { handleSSEEvent } = getStore();

    handleSSEEvent({ type: 'RUN_STARTED', runId: 'r1' });
    handleSSEEvent({ type: 'TEXT_MESSAGE_START', role: 'assistant' });
    handleSSEEvent({ type: 'TOOL_CALL_START', toolCallId: 'tc1', name: 'fail' });
    handleSSEEvent({ type: 'TOOL_CALL_RESULT', toolCallId: 'tc1', result: '', error: 'boom' });

    const tc = getStore().toolCalls.get('tc1');
    expect(tc!.status).toBe('error');
    expect(tc!.error).toBe('boom');
  });
});
