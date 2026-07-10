import { describe, expect, it } from 'vitest';

import { createInitialChatState, reduceCtxmillChatState } from './state.js';

describe('@ctxmill/react chat reducer', () => {
  it('reduces text, A2UI, and HITL events into chat state', () => {
    let state = createInitialChatState('conv-1');

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: { type: 'RUN_STARTED', runId: 'run-1', threadId: 'conv-1' },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: { type: 'TEXT_MESSAGE_START', runId: 'run-1', threadId: 'conv-1', messageId: 'assistant-1', role: 'assistant' },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: { type: 'TEXT_MESSAGE_CONTENT', runId: 'run-1', threadId: 'conv-1', messageId: 'assistant-1', delta: 'Here is a chart.' },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'CUSTOM',
        name: 'ctxmill.a2ui.render',
        block: { id: 'block-1', component: 'MetricCard', props: { title: 'Revenue', value: '$42k' } },
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'CUSTOM',
        name: 'ctxmill.hitl.requested',
        interruptId: 'run-1',
        toolCallId: 'tool-1',
        toolName: 'request-approval',
        args: { reason: 'Ship it' },
      },
    });

    expect(state.isRunning).toBe(true);
    expect(state.messages[0]?.content).toBe('Here is a chart.');
    expect(state.messages[0]?.parts).toContainEqual({
      type: 'a2ui',
      block: { id: 'block-1', component: 'MetricCard', props: { title: 'Revenue', value: '$42k' } },
    });
    expect(state.pendingHitl?.id).toBe('run-1');
  });

  it('uses the canonical RUN_ERROR message field', () => {
    const state = reduceCtxmillChatState(
      { ...createInitialChatState('conv-1'), isRunning: true },
      {
        type: 'stream_event',
        event: { type: 'RUN_ERROR', runId: 'run-1', threadId: 'conv-1', message: 'tool execution failed' },
      },
    );

    expect(state.isRunning).toBe(false);
    expect(state.error).toBe('tool execution failed');
  });
});
