import { describe, expect, it } from 'vitest';

import { CanonicalProjector } from '../projector.js';

describe('CanonicalProjector takeover rehydration (ADR 025)', () => {
  const base = { turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1', timestamp: 1 };
  const delta = (text: string) => ({ ...base, messageId: 'ignored', delta: text });
  const toolStart = { ...base, toolCallId: 'tc-1', toolName: 'search', args: {} };

  function persisted(
    projector: CanonicalProjector,
    events: Array<[string, Record<string, unknown>]>,
  ) {
    return events.flatMap(([name, payload]) => projector.project(name, payload));
  }

  it('continues an open synthesized message instead of reusing its id', () => {
    const original = new CanonicalProjector();
    const frames = persisted(original, [
      ['message.delta', delta('one')],
      ['tool_call.started', toolStart],
      ['message.delta', delta('two')],
    ]);

    const successor = new CanonicalProjector();
    successor.restoreTurnTextState('turn-1', frames);
    const next = successor.project('message.delta', delta('three'));

    expect(next.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_CONTENT']);
    expect(next[0]?.body.messageId).toBe('turn-1-m2');
    expect(next).toEqual(original.project('message.delta', delta('three')).map((frame) => ({
      ...frame,
      sourcePayload: next[0]?.sourcePayload,
    })));
  });

  it('opens the next ordinal after a closed message', () => {
    const original = new CanonicalProjector();
    const frames = persisted(original, [
      ['message.delta', delta('one')],
      ['tool_call.started', toolStart],
    ]);

    const successor = new CanonicalProjector();
    successor.restoreTurnTextState('turn-1', frames);
    const next = successor.project('message.delta', delta('two'));

    expect(next.map((frame) => [frame.type, frame.body.messageId])).toEqual([
      ['TEXT_MESSAGE_START', 'turn-1-m2'],
      ['TEXT_MESSAGE_CONTENT', 'turn-1-m2'],
    ]);
  });

  it('ignores user-message and harness-native message ids', () => {
    const successor = new CanonicalProjector();
    successor.restoreTurnTextState('turn-1', [
      { type: 'TEXT_MESSAGE_START', body: { messageId: 'user-msg-1', role: 'user' } },
      { type: 'TEXT_MESSAGE_START', body: { messageId: 'harness-abc', role: 'assistant' } },
    ]);
    const next = successor.project('message.delta', delta('first'));
    expect(next[0]?.body.messageId).toBe('turn-1-m1');
  });
});
