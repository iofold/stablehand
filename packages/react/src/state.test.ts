import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseCanonicalStreamEvent } from '@ctxmill/client';

import {
  createInitialChatState,
  reduceCtxmillChatState,
  toCtxmillMessages,
} from './state.js';

describe('@ctxmill/react chat reducer', () => {
  it('reduces every server-emitted canonical fixture frame', () => {
    const fixture = JSON.parse(readFileSync(
      new URL('../../contracts/test-fixtures/canonical-stream-events.json', import.meta.url),
      'utf8',
    )) as unknown[];
    let state = createInitialChatState('conversation-1');

    for (const raw of fixture) {
      state = reduceCtxmillChatState(state, {
        type: 'stream_event',
        event: parseCanonicalStreamEvent(raw),
      });
    }

    expect(state.error).toBe('Harness failed');
  });

  it('reduces canonical text, A2UI, and interrupt events into chat state', () => {
    let state = createInitialChatState('conversation-1');

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'RUN_STARTED',
        runId: 'turn-1',
        threadId: 'conversation-1',
        timestamp: 1,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_START',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'assistant-1',
        role: 'assistant',
        timestamp: 2,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'assistant-1',
        delta: 'Here is a chart.',
        timestamp: 3,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'CUSTOM',
        name: 'ctxmill.a2ui.render',
        runId: 'turn-1',
        threadId: 'conversation-1',
        block: {
          id: 'block-1',
          component: 'MetricCard',
          props: { title: 'Revenue', value: '$42k' },
        },
        timestamp: 4,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'CUSTOM',
        name: 'ctxmill.interrupt.requested',
        agentId: 'agent-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        interruptId: 'interrupt-1',
        toolCallId: 'tool-1',
        toolCallName: 'request-approval',
        args: { reason: 'Ship it' },
        timestamp: 5,
      },
    });

    expect(state.isRunning).toBe(true);
    expect(state.messages[0]?.content).toBe('Here is a chart.');
    expect(state.messages.flatMap((message) => message.parts)).toContainEqual({
      type: 'a2ui',
      block: {
        id: 'block-1',
        component: 'MetricCard',
        props: { title: 'Revenue', value: '$42k' },
      },
    });
    expect(state.pendingHitl).toEqual({
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      toolCallId: 'tool-1',
      toolCallName: 'request-approval',
      args: { reason: 'Ship it' },
    });
  });

  it('tracks the run phase with canonical tool result frames', () => {
    let state = createInitialChatState('conversation-1');
    expect(state.runPhase).toBe('idle');

    state = reduceCtxmillChatState(state, {
      type: 'append_user_message',
      message: { id: 'user-1', role: 'user', content: 'hi' },
    });
    expect(state.runPhase).toBe('submitted');

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'CUSTOM',
        name: 'ctxmill.turn.pending',
        agentId: 'agent-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        mode: 'interactive',
        timestamp: 1,
      },
    });
    expect(state.runPhase).toBe('provisioning');

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'RUN_STARTED',
        runId: 'turn-1',
        threadId: 'conversation-1',
        timestamp: 2,
      },
    });
    expect(state.runPhase).toBe('thinking');

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TOOL_CALL_START',
        runId: 'turn-1',
        threadId: 'conversation-1',
        toolCallId: 'tool-1',
        toolCallName: 'search',
        timestamp: 3,
      },
    });
    expect(state.runPhase).toBe('tool');

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TOOL_CALL_END',
        runId: 'turn-1',
        threadId: 'conversation-1',
        toolCallId: 'tool-1',
        timestamp: 4,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TOOL_CALL_RESULT',
        runId: 'turn-1',
        threadId: 'conversation-1',
        toolCallId: 'tool-1',
        result: 'ok',
        timestamp: 5,
      },
    });
    expect(state.runPhase).toBe('thinking');
    expect(state.messages.flatMap((message) => message.parts)).toContainEqual({
      type: 'tool_call',
      id: 'tool-1',
      name: 'search',
      args: '',
      result: 'ok',
      status: 'complete',
    });

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'assistant-1',
        delta: 'Hello',
        timestamp: 6,
      },
    });
    expect(state.runPhase).toBe('streaming');

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'RUN_FINISHED',
        runId: 'turn-1',
        threadId: 'conversation-1',
        timestamp: 7,
      },
    });
    expect(state.isRunning).toBe(false);
    expect(state.runPhase).toBe('idle');
  });

  it('clears only the matching canonical interrupt resolution', () => {
    const pending = {
      interruptId: 'interrupt-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      agentId: 'agent-1',
      toolCallId: 'tool-1',
      toolCallName: 'request-approval',
      args: {},
    };
    const state = {
      ...createInitialChatState('conversation-1'),
      pendingHitl: pending,
    };

    const unrelated = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'CUSTOM',
        name: 'ctxmill.interrupt.resolved',
        agentId: 'agent-1',
        turnId: 'turn-2',
        conversationId: 'conversation-2',
        interruptId: 'interrupt-2',
        action: 'approve',
        timestamp: 1,
      },
    });
    expect(unrelated.pendingHitl).toEqual(pending);

    const resolved = reduceCtxmillChatState(unrelated, {
      type: 'stream_event',
      event: {
        type: 'CUSTOM',
        name: 'ctxmill.interrupt.resolved',
        agentId: 'agent-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        interruptId: 'interrupt-1',
        action: 'approve',
        timestamp: 2,
      },
    });
    expect(resolved.pendingHitl).toBeNull();
  });

  it('settles a run whose stream ends without a terminal frame', () => {
    let state = createInitialChatState('conversation-1');
    state = reduceCtxmillChatState(state, {
      type: 'append_user_message',
      message: { id: 'user-1', role: 'user', content: 'hi' },
    });
    expect(state.isRunning).toBe(true);

    state = reduceCtxmillChatState(state, { type: 'run_settled' });
    expect(state.isRunning).toBe(false);
    expect(state.runPhase).toBe('idle');
    expect(state.activeAssistantMessageId).toBeNull();
  });

  it('discards only a user message whose optimistic send was rejected', () => {
    let state = reduceCtxmillChatState(
      createInitialChatState('conversation-1'),
      {
        type: 'append_user_message',
        message: {
          id: 'optimistic-user-1',
          role: 'user',
          content: 'Reject this send',
        },
      },
    );

    state = reduceCtxmillChatState(state, {
      type: 'discard_optimistic_user_message',
      messageId: 'optimistic-user-1',
    });

    expect(state.messages).toEqual([]);
    expect(state.optimisticUserMessageIds).toEqual([]);
  });

  it('uses the canonical RUN_ERROR message field', () => {
    const state = reduceCtxmillChatState(
      { ...createInitialChatState('conversation-1'), isRunning: true },
      {
        type: 'stream_event',
        event: {
          type: 'RUN_ERROR',
          runId: 'turn-1',
          threadId: 'conversation-1',
          message: 'tool execution failed',
          timestamp: 1,
        },
      },
    );

    expect(state.isRunning).toBe(false);
    expect(state.error).toBe('tool execution failed');
  });

  it('preserves the role of a server-emitted user message', () => {
    const state = reduceCtxmillChatState(
      createInitialChatState('conversation-1'),
      {
        type: 'stream_event',
        event: {
          type: 'TEXT_MESSAGE_START',
          runId: 'turn-1',
          threadId: 'conversation-1',
          messageId: 'message-user-1',
          role: 'user',
          timestamp: 1,
        },
      },
    );

    expect(state.messages[0]?.role).toBe('user');
  });

  it('reconciles an optimistic user message with its canonical server echo', () => {
    let state = reduceCtxmillChatState(
      createInitialChatState('conversation-1'),
      {
        type: 'append_user_message',
        message: {
          id: 'optimistic-user-1',
          role: 'user',
          content: 'Reconcile me once',
        },
      },
    );

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_START',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'canonical-user-1',
        role: 'user',
        timestamp: 1,
      },
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: 'canonical-user-1',
      content: 'Reconcile me once',
      createdAt: '1970-01-01T00:00:00.001Z',
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'canonical-user-1',
        delta: 'Reconcile me once',
        timestamp: 2,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_END',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'canonical-user-1',
        timestamp: 3,
      },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: 'canonical-user-1',
      role: 'user',
      content: 'Reconcile me once',
    });
    expect(state.activeAssistantMessageId).toBeNull();
  });

  it('does not attach a tool call to the preceding user echo', () => {
    let state = createInitialChatState('conversation-1');
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_START',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'canonical-user-1',
        role: 'user',
        timestamp: 1,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TEXT_MESSAGE_CONTENT',
        runId: 'turn-1',
        threadId: 'conversation-1',
        messageId: 'canonical-user-1',
        delta: 'Use a tool',
        timestamp: 2,
      },
    });
    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: {
        type: 'TOOL_CALL_START',
        runId: 'turn-1',
        threadId: 'conversation-1',
        toolCallId: 'tool-1',
        toolCallName: 'search',
        timestamp: 3,
      },
    });

    const userMessage = state.messages.find(
      (message) => message.id === 'canonical-user-1',
    );
    const toolMessage = state.messages.find(
      (message) => message.id === 'assistant-turn-1',
    );
    expect(userMessage?.parts).toEqual([
      { type: 'text', content: 'Use a tool' },
    ]);
    expect(toolMessage?.parts).toContainEqual({
      type: 'tool_call',
      id: 'tool-1',
      name: 'search',
      args: '',
      status: 'running',
    });
  });

  it('keeps the active assistant projection when a canonical tool message is committed', () => {
    let state = createInitialChatState('conversation-1');
    const emit = (raw: unknown) => {
      state = reduceCtxmillChatState(state, {
        type: 'stream_event',
        event: parseCanonicalStreamEvent(raw),
      });
    };
    const customIdentity = {
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
    };

    emit({
      type: 'RUN_STARTED',
      runId: 'turn-1',
      threadId: 'conversation-1',
      timestamp: 1,
    });
    emit({
      type: 'TOOL_CALL_START',
      runId: 'turn-1',
      threadId: 'conversation-1',
      toolCallId: 'tool-1',
      toolCallName: 'lookup',
      timestamp: 2,
    });
    emit({
      type: 'CUSTOM',
      name: 'ctxmill.message.committed',
      ...customIdentity,
      messageId: 'assistant-canonical',
      messageSeq: 0,
      role: 'assistant',
      content: '',
      parts: [{
        type: 'tool_call',
        id: 'tool-1',
        name: 'lookup',
        args: '{}',
        result: 'full accumulated result',
        status: 'complete',
      }],
      toolCalls: [{
        id: 'tool-1',
        name: 'lookup',
        args: '{}',
        result: 'full accumulated result',
        status: 'complete',
      }],
      timestamp: 3,
    });
    emit({
      type: 'CUSTOM',
      name: 'ctxmill.message.committed',
      ...customIdentity,
      messageId: 'tool-canonical',
      messageSeq: 1,
      role: 'tool',
      content: 'full accumulated result',
      parts: [{
        type: 'text',
        content: 'full accumulated result',
      }],
      toolCalls: [],
      toolCallId: 'tool-1',
      timestamp: 4,
    });

    expect(state.messages.map(({ id }) => id)).toEqual([
      'assistant-canonical',
      'tool-canonical',
    ]);
    expect(state.messages[0]?.parts).toContainEqual({
      type: 'tool_call',
      id: 'tool-1',
      name: 'lookup',
      args: '{}',
      result: 'full accumulated result',
      status: 'complete',
    });
    expect(state.messages[1]).toMatchObject({
      id: 'tool-canonical',
      toolCallId: 'tool-1',
      createdAt: '1970-01-01T00:00:00.004Z',
    });
    expect(state.activeAssistantMessageId).toBe('assistant-canonical');
  });

  it('does not let a later raw tool result replace a canonical tool outcome', () => {
    let state = createInitialChatState('conversation-1');
    const emit = (raw: unknown) => {
      state = reduceCtxmillChatState(state, {
        type: 'stream_event',
        event: parseCanonicalStreamEvent(raw),
      });
    };
    const runIdentity = {
      runId: 'turn-1',
      threadId: 'conversation-1',
    };
    const customIdentity = {
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
    };

    emit({
      type: 'RUN_STARTED',
      ...runIdentity,
      timestamp: 1,
    });
    emit({
      type: 'TOOL_CALL_START',
      ...runIdentity,
      toolCallId: 'tool-1',
      toolCallName: 'lookup',
      timestamp: 2,
    });
    emit({
      type: 'CUSTOM',
      name: 'ctxmill.message.committed',
      ...customIdentity,
      messageId: 'assistant-canonical',
      messageSeq: 0,
      role: 'assistant',
      content: '',
      parts: [{
        type: 'tool_call',
        id: 'tool-1',
        name: 'lookup',
        args: '{}',
        result: 'canonical result...',
        status: 'complete',
      }],
      timestamp: 3,
    });
    emit({
      type: 'CUSTOM',
      name: 'ctxmill.message.committed',
      ...customIdentity,
      messageId: 'tool-canonical',
      messageSeq: 1,
      role: 'tool',
      content: 'canonical result...',
      toolCallId: 'tool-1',
      timestamp: 4,
    });
    emit({
      type: 'TOOL_CALL_RESULT',
      ...runIdentity,
      toolCallId: 'tool-1',
      result: 'canonical result',
      timestamp: 5,
    });

    expect(state.messages[0]?.parts).toContainEqual({
      type: 'tool_call',
      id: 'tool-1',
      name: 'lookup',
      args: '{}',
      result: 'canonical result...',
      status: 'complete',
    });
  });

  it('hydrates missing tool parts from REST toolCalls and ignores an older committed baseline', () => {
    let state = reduceCtxmillChatState(createInitialChatState('conversation-1'), {
      type: 'load_messages',
      messages: [{
        id: 'message-1',
        messageRevision: 2,
        role: 'assistant',
        content: 'Authoritative REST projection',
        parts: [{ type: 'text', content: 'Authoritative REST projection' }],
        toolCalls: [{
          id: 'tool-1',
          name: 'search',
          args: '{}',
          result: 'found',
          status: 'complete',
        }],
      }],
    });

    expect(state.messages[0]?.parts).toEqual([
      { type: 'text', content: 'Authoritative REST projection' },
      {
        type: 'tool_call',
        id: 'tool-1',
        name: 'search',
        args: '{}',
        result: 'found',
        status: 'complete',
      },
    ]);

    state = reduceCtxmillChatState(state, {
      type: 'stream_event',
      event: parseCanonicalStreamEvent({
        type: 'CUSTOM',
        name: 'ctxmill.message.committed',
        agentId: 'agent-1',
        turnId: 'turn-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        messageSeq: 0,
        role: 'assistant',
        content: 'Older baseline',
        parts: [{ type: 'text', content: 'Older baseline' }],
        timestamp: 1,
      }),
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe('Authoritative REST projection');
    expect(state.messageRevisions.get('message-1')).toBe(2);
  });

  it('preserves canonical persisted timestamps across transcript reloads', () => {
    const state = reduceCtxmillChatState(
      createInitialChatState('conversation-1'),
      {
        type: 'load_messages',
        messages: [{
          id: 'message-1',
          messageRevision: 0,
          role: 'assistant',
          content: 'Persisted answer',
          createdAt: '2026-07-20T11:28:55.222Z',
        }],
      },
    );

    expect(state.messages[0]?.createdAt).toBe(
      '2026-07-20T11:28:55.222Z',
    );
  });

  it('preserves timestamps and tool-result identity from AG-UI snapshots', () => {
    const state = reduceCtxmillChatState(
      createInitialChatState('conversation-1'),
      {
        type: 'stream_event',
        event: parseCanonicalStreamEvent({
          type: 'MESSAGES_SNAPSHOT',
          runId: 'turn-1',
          threadId: 'conversation-1',
          messages: [{
            id: 'tool-message-1',
            role: 'tool',
            content: 'APPROVED',
            toolCallId: 'tool-call-1',
            createdAt: 1_784_546_935_222,
          }],
        }),
      },
    );

    expect(state.messages[0]).toMatchObject({
      id: 'tool-message-1',
      role: 'tool',
      toolCallId: 'tool-call-1',
      createdAt: '2026-07-20T11:28:55.222Z',
    });
    expect(toCtxmillMessages(state.messages)[0]).toMatchObject({
      id: 'tool-message-1',
      role: 'tool',
      toolCallId: 'tool-call-1',
    });
  });

  it('keeps canonical message revisions authoritative across replay and REST convergence', () => {
    let state = createInitialChatState('conversation-1');
    const emit = (raw: unknown) => {
      state = reduceCtxmillChatState(state, {
        type: 'stream_event',
        event: parseCanonicalStreamEvent(raw),
      });
    };
    const runIdentity = {
      runId: 'turn-1',
      threadId: 'conversation-1',
    };
    const customIdentity = {
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conversation-1',
    };

    emit({ type: 'RUN_STARTED', ...runIdentity, timestamp: 1 });
    emit({
      type: 'TEXT_MESSAGE_START',
      ...runIdentity,
      messageId: 'live-tool-1',
      role: 'assistant',
      timestamp: 2,
    });
    emit({
      type: 'TOOL_CALL_START',
      ...runIdentity,
      toolCallId: 'tool-1',
      toolCallName: 'search',
      timestamp: 3,
    });
    emit({
      type: 'TOOL_CALL_RESULT',
      ...runIdentity,
      toolCallId: 'tool-1',
      result: 'first',
      timestamp: 4,
    });

    const baselineCommit = {
      type: 'CUSTOM',
      name: 'ctxmill.message.committed',
      ...customIdentity,
      messageId: 'message-tools',
      messageSeq: 0,
      role: 'assistant',
      content: '',
      parts: [
        { type: 'tool_call', id: 'tool-1', name: 'search', args: '', result: 'first', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tool-1', name: 'search', args: '', status: 'complete' },
      ],
      timestamp: 5,
    };
    emit(baselineCommit);
    emit(baselineCommit);

    emit({
      type: 'TEXT_MESSAGE_START',
      ...runIdentity,
      messageId: 'live-tool-2',
      role: 'assistant',
      timestamp: 6,
    });
    emit({
      type: 'TEXT_MESSAGE_CONTENT',
      ...runIdentity,
      messageId: 'live-tool-2',
      delta: 'Need one more check.',
      timestamp: 7,
    });
    emit({
      type: 'TOOL_CALL_START',
      ...runIdentity,
      toolCallId: 'tool-2',
      toolCallName: 'lookup',
      timestamp: 8,
    });
    emit({
      type: 'TOOL_CALL_RESULT',
      ...runIdentity,
      toolCallId: 'tool-2',
      result: 'second',
      timestamp: 9,
    });

    const revisionOne = {
      type: 'CUSTOM',
      name: 'ctxmill.message.updated',
      ...customIdentity,
      messageId: 'message-tools',
      messageSeq: 0,
      messageRevision: 1,
      role: 'assistant',
      content: '',
      parts: [
        { type: 'tool_call', id: 'tool-1', name: 'search', args: '', result: 'first', status: 'complete' },
        { type: 'text', content: 'Need one more check.' },
        { type: 'tool_call', id: 'tool-2', name: 'lookup', args: '', result: 'second', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tool-1', name: 'search', args: '', status: 'complete' },
        { id: 'tool-2', name: 'lookup', args: '', status: 'complete' },
      ],
      timestamp: 10,
    };
    emit(revisionOne);

    emit({
      type: 'TEXT_MESSAGE_START',
      ...runIdentity,
      messageId: 'live-tool-3',
      role: 'assistant',
      timestamp: 11,
    });
    emit({
      type: 'TEXT_MESSAGE_CONTENT',
      ...runIdentity,
      messageId: 'live-tool-3',
      delta: 'Final check.',
      timestamp: 12,
    });
    emit({
      type: 'TOOL_CALL_START',
      ...runIdentity,
      toolCallId: 'tool-3',
      toolCallName: 'read',
      timestamp: 13,
    });
    emit({
      type: 'TOOL_CALL_RESULT',
      ...runIdentity,
      toolCallId: 'tool-3',
      result: 'third',
      timestamp: 14,
    });
    emit({
      type: 'CUSTOM',
      name: 'ctxmill.message.updated',
      ...customIdentity,
      messageId: 'message-tools',
      messageSeq: 0,
      messageRevision: 2,
      role: 'assistant',
      content: '',
      parts: [
        { type: 'tool_call', id: 'tool-1', name: 'search', args: '', result: 'first', status: 'complete' },
        { type: 'text', content: 'Need one more check.' },
        { type: 'tool_call', id: 'tool-2', name: 'lookup', args: '', result: 'second', status: 'complete' },
        { type: 'text', content: 'Final check.' },
        { type: 'tool_call', id: 'tool-3', name: 'read', args: '', result: 'third', status: 'complete' },
      ],
      toolCalls: [
        { id: 'tool-1', name: 'search', args: '', status: 'complete' },
        { id: 'tool-2', name: 'lookup', args: '', status: 'complete' },
        { id: 'tool-3', name: 'read', args: '', status: 'complete' },
      ],
      timestamp: 15,
    });
    emit(revisionOne);

    emit({
      type: 'TEXT_MESSAGE_START',
      ...runIdentity,
      messageId: 'live-final',
      role: 'assistant',
      timestamp: 16,
    });
    emit({
      type: 'TEXT_MESSAGE_CONTENT',
      ...runIdentity,
      messageId: 'live-final',
      delta: 'Done.',
      timestamp: 17,
    });
    const finalCommit = {
      type: 'CUSTOM',
      name: 'ctxmill.message.committed',
      ...customIdentity,
      messageId: 'message-final',
      messageSeq: 1,
      role: 'assistant',
      content: 'Done.',
      parts: [{ type: 'text', content: 'Done.' }],
      toolCalls: [],
      timestamp: 18,
    };
    emit(finalCommit);
    emit(finalCommit);
    emit({ type: 'RUN_FINISHED', ...runIdentity, status: 'completed', timestamp: 19 });

    expect(state.messages.map((message) => message.id)).toEqual([
      'message-tools',
      'message-final',
    ]);
    expect(state.messages[0]?.parts).toEqual([
      { type: 'tool_call', id: 'tool-1', name: 'search', args: '', result: 'first', status: 'complete' },
      { type: 'text', content: 'Need one more check.' },
      { type: 'tool_call', id: 'tool-2', name: 'lookup', args: '', result: 'second', status: 'complete' },
      { type: 'text', content: 'Final check.' },
      { type: 'tool_call', id: 'tool-3', name: 'read', args: '', result: 'third', status: 'complete' },
    ]);
    expect(state.messageRevisions.get('message-tools')).toBe(2);

    state = reduceCtxmillChatState(state, {
      type: 'load_messages',
      threadId: 'conversation-1',
      messages: [
        {
          id: 'message-tools',
          messageRevision: 2,
          role: 'assistant',
          content: '',
          parts: state.messages[0]!.parts,
        },
        {
          id: 'message-final',
          messageRevision: 0,
          role: 'assistant',
          content: 'Done.',
          parts: [{ type: 'text', content: 'Done.' }],
        },
      ],
    });

    expect(state.messages.map((message) => message.id)).toEqual([
      'message-tools',
      'message-final',
    ]);
    expect(state.messages[0]?.parts).toHaveLength(5);
    expect(state.messageRevisions.get('message-tools')).toBe(2);
  });
});
