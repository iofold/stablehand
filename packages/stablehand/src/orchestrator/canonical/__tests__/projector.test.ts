import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CanonicalStreamEventSchema } from '@stablehand/contracts';

import { STABLEHAND_CUSTOM_NAMES, KNOWN_BUS_EVENT_NAMES, RUN_CHANNEL_EVENTS } from '../frames.js';
import { CanonicalProjector } from '../projector.js';

const T = 1_000;
const canonicalFixture = JSON.parse(readFileSync(
  new URL('../../../../../contracts/test-fixtures/canonical-stream-events.json', import.meta.url),
  'utf8',
)) as Array<Record<string, unknown>>;

function messageDelta(turnId: string, delta: string, messageId = 'sandbox-msg') {
  return { turnId, agentId: 'agent-1', conversationId: 'conv-1', messageId, delta, timestamp: T };
}

describe('CanonicalProjector (ADR-015)', () => {
  it('projects the shared canonical stream fixture without compatibility fields', () => {
    const projector = new CanonicalProjector();
    const standardOrGeneric = canonicalFixture.filter((event) =>
      event.type !== 'CUSTOM'
      || (typeof event.name === 'string' && !event.name.startsWith('stablehand.')),
    );

    for (const expected of standardOrGeneric) {
      const timestamp = typeof expected.timestamp === 'number' ? expected.timestamp : T;
      const [frame] = projector.project('ag_ui.event', {
        turnId: typeof expected.runId === 'string' ? expected.runId : 'turn-1',
        agentId: 'agent-1',
        conversationId: typeof expected.threadId === 'string' ? expected.threadId : 'conversation-1',
        event: expected,
        timestamp,
      });

      expect(frame?.body).toEqual({
        ...expected,
        ...(expected.timestamp === undefined ? { timestamp } : {}),
      });
    }

    const customFixture = (name: string): Record<string, unknown> => {
      const event = canonicalFixture.find((candidate) => candidate.name === name);
      if (!event) throw new Error(`Missing ${name} from canonical stream fixture`);
      return event;
    };

    const pending = customFixture('stablehand.turn.pending');
    expect(projector.project('turn.pending', {
      turnId: pending.turnId,
      agentId: pending.agentId,
      conversationId: pending.conversationId,
      mode: pending.mode,
      taskDescription: pending.taskDescription,
      timestamp: pending.timestamp,
    })[0]?.body).toEqual(pending);

    const requested = customFixture('stablehand.interrupt.requested');
    expect(projector.project('interrupt.requested', {
      turnId: requested.turnId,
      sandboxSessionId: requested.sandboxSessionId,
      agentId: requested.agentId,
      conversationId: requested.conversationId,
      interruptId: requested.interruptId,
      toolCallId: requested.toolCallId,
      toolName: requested.toolName,
      args: requested.args,
      timestamp: requested.timestamp,
    })[0]?.body).toEqual(requested);

    const resolved = customFixture('stablehand.interrupt.resolved');
    expect(projector.project('interrupt.resolved', {
      turnId: resolved.turnId,
      sandboxSessionId: resolved.sandboxSessionId,
      agentId: resolved.agentId,
      conversationId: resolved.conversationId,
      interruptId: resolved.interruptId,
      action: resolved.action,
      timestamp: resolved.timestamp,
    })[0]?.body).toEqual(resolved);

    const committed = customFixture('stablehand.message.committed');
    expect(projector.project('message.committed', {
      turnId: committed.turnId,
      agentId: committed.agentId,
      conversationId: committed.conversationId,
      messageId: committed.messageId,
      messageSeq: committed.messageSeq,
      role: committed.role,
      content: committed.content,
      parts: committed.parts,
      toolCalls: committed.toolCalls,
      timestamp: committed.timestamp,
    })[0]?.body).toEqual(committed);

    const updated = customFixture('stablehand.message.updated');
    expect(projector.project('message.updated', {
      turnId: updated.turnId,
      agentId: updated.agentId,
      conversationId: updated.conversationId,
      messageId: updated.messageId,
      messageSeq: updated.messageSeq,
      messageRevision: updated.messageRevision,
      role: updated.role,
      content: updated.content,
      parts: updated.parts,
      toolCalls: updated.toolCalls,
      timestamp: updated.timestamp,
    })[0]?.body).toEqual(updated);

    const a2ui = customFixture('stablehand.a2ui.render');
    const a2uiFrames = projector.project('tool_call.completed', {
      turnId: a2ui.runId,
      agentId: 'agent-1',
      conversationId: a2ui.threadId,
      toolCallId: (a2ui.block as Record<string, unknown>).id,
      toolName: 'a2ui-render',
      result: JSON.stringify(a2ui.block),
      durationMs: 0,
      timestamp: a2ui.timestamp,
    });
    expect(a2uiFrames.find((frame) => frame.body.name === 'stablehand.a2ui.render')?.body).toEqual(a2ui);
  });

  it('exposes only the canonical event and custom-name vocabulary', () => {
    expect(KNOWN_BUS_EVENT_NAMES).toEqual(expect.arrayContaining([
      'message.delta',
      'tool_call.started',
      'tool_call.completed',
      'interrupt.requested',
      'interrupt.resolved',
      'ag_ui.event',
    ]));
    for (const retiredName of [
      'run.text_chunk',
      'run.tool_started',
      'run.tool_result',
      'run.interrupted',
      'run.interrupt_resolved',
      'run.ag_ui_event',
    ]) {
      expect(KNOWN_BUS_EVENT_NAMES).not.toContain(retiredName);
    }
    expect(STABLEHAND_CUSTOM_NAMES).toEqual(expect.arrayContaining([
      'stablehand.interrupt.requested',
      'stablehand.interrupt.resolved',
      'stablehand.sandbox_session.snapshot',
      'stablehand.message.updated',
    ]));
    for (const retiredName of [
      'stablehand.hitl.requested',
      'stablehand.hitl.resolved',
    ]) {
      expect(STABLEHAND_CUSTOM_NAMES).not.toContain(retiredName);
    }
  });

  it('synthesizes stable assistant message boundaries per turn', () => {
    const projector = new CanonicalProjector();

    const first = projector.project('message.delta', messageDelta('turn-1', 'Hel'));
    expect(first.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
    expect(first[0]!.body.messageId).toBe('turn-1-m1');
    expect(first[1]!.body).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      runId: 'turn-1',
      threadId: 'conv-1',
      messageId: 'turn-1-m1',
      delta: 'Hel',
      timestamp: T,
    });

    const second = projector.project('message.delta', messageDelta('turn-1', 'lo'));
    expect(second.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_CONTENT']);
    expect(second[0]!.body.messageId).toBe('turn-1-m1');
    expect(second[0]!.body.delta).toBe('lo');

    // Tool start closes the message; the next chunk opens turn-1-m2.
    const toolFrames = projector.project('tool_call.started', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      toolCallId: 'tc-1', toolName: 'bash', args: { cmd: 'ls' }, timestamp: T,
    });
    expect(toolFrames.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS']);
    expect(toolFrames[0]!.body.messageId).toBe('turn-1-m1');
    expect(toolFrames[1]!.body).toEqual({
      type: 'TOOL_CALL_START',
      runId: 'turn-1',
      threadId: 'conv-1',
      toolCallId: 'tc-1',
      toolCallName: 'bash',
      timestamp: T,
    });
    expect(toolFrames[2]!.body).toEqual({
      type: 'TOOL_CALL_ARGS',
      runId: 'turn-1',
      threadId: 'conv-1',
      toolCallId: 'tc-1',
      delta: '{"cmd":"ls"}',
      timestamp: T,
    });

    const third = projector.project('message.delta', messageDelta('turn-1', 'done'));
    expect(third[0]!.body.messageId).toBe('turn-1-m2');
  });

  it('omits role from synthesized assistant TEXT_MESSAGE_END frames', () => {
    const projector = new CanonicalProjector();
    projector.project('message.delta', messageDelta('turn-1', 'done'));

    const frames = projector.project('turn.completed', {
      turnId: 'turn-1', sandboxSessionId: 'sandbox-1', agentId: 'agent-1', conversationId: 'conv-1',
      status: 'completed', durationMs: 5, timestamp: T,
    });
    const end = frames.find((frame) => frame.type === 'TEXT_MESSAGE_END');

    expect(end?.body).not.toHaveProperty('role');
  });

  it('strictly parses synthesized assistant TEXT_MESSAGE_END frames', () => {
    const projector = new CanonicalProjector();
    projector.project('message.delta', messageDelta('turn-1', 'done'));

    const frames = projector.project('turn.completed', {
      turnId: 'turn-1', sandboxSessionId: 'sandbox-1', agentId: 'agent-1', conversationId: 'conv-1',
      status: 'completed', durationMs: 5, timestamp: T,
    });
    const end = frames.find((frame) => frame.type === 'TEXT_MESSAGE_END');

    expect(() => CanonicalStreamEventSchema.parse(end?.body)).not.toThrow();
  });

  it('keeps message boundaries independent across concurrent turns', () => {
    const projector = new CanonicalProjector();
    projector.project('message.delta', messageDelta('turn-a', 'x'));
    const other = projector.project('message.delta', messageDelta('turn-b', 'y'));
    expect(other[0]!.body.messageId).toBe('turn-b-m1');
  });

  it('closes open text and emits spec RUN_ERROR message on failed turn completion', () => {
    const projector = new CanonicalProjector();
    projector.project('message.delta', messageDelta('turn-1', 'partial'));

    const frames = projector.project('turn.completed', {
      turnId: 'turn-1', sandboxSessionId: 'sandbox-1', agentId: 'agent-1', conversationId: 'conv-1',
      status: 'error', error: 'boom', durationMs: 5, timestamp: T,
    });

    expect(frames.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_END', 'RUN_ERROR', 'RUN_FINISHED']);
    expect(frames[1]!.body.message).toBe('boom');
    expect(frames[2]!.body.status).toBe('error');
  });

  it('detects a2ui-render results and emits a replayable CUSTOM frame', () => {
    const projector = new CanonicalProjector();
    const frames = projector.project('tool_call.completed', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      toolCallId: 'tc-1', toolName: 'a2ui-render',
      result: JSON.stringify({ component: 'Chart', props: { series: [1] } }),
      timestamp: T,
    });

    expect(frames.map((frame) => frame.type)).toEqual(['TOOL_CALL_END', 'TOOL_CALL_RESULT', 'CUSTOM']);
    expect(frames[0]!.body).toEqual({
      type: 'TOOL_CALL_END',
      runId: 'turn-1',
      threadId: 'conv-1',
      toolCallId: 'tc-1',
      timestamp: T,
    });
    expect(frames[1]!.body).toEqual({
      type: 'TOOL_CALL_RESULT',
      runId: 'turn-1',
      threadId: 'conv-1',
      toolCallId: 'tc-1',
      result: JSON.stringify({ component: 'Chart', props: { series: [1] } }),
      timestamp: T,
    });
    expect(frames[2]!.body.name).toBe('stablehand.a2ui.render');
    expect(frames[2]!.body).toEqual({
      type: 'CUSTOM',
      name: 'stablehand.a2ui.render',
      runId: 'turn-1',
      threadId: 'conv-1',
      block: { id: 'tc-1', component: 'Chart', props: { series: [1] } },
      timestamp: T,
    });
  });

  it('projects user messages as a full triplet keyed to the turn and conversation', () => {
    const projector = new CanonicalProjector();
    const frames = projector.project('user.message', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      messageId: 'msg-9', content: 'hi', timestamp: T,
    });
    expect(frames.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
    expect(frames[0]!.body.role).toBe('user');
    expect(frames[1]!.body).not.toHaveProperty('role');
    expect(frames[2]!.body).not.toHaveProperty('role');
    expect(frames.every((frame) => !('content' in frame.body))).toBe(true);
    expect(frames.every((frame) => frame.turnId === 'turn-1')).toBe(true);
    expect(frames.every((frame) => frame.conversationId === 'conv-1')).toBe(true);
    expect(frames.every((frame) => frame.body.runId === 'turn-1')).toBe(true);
    expect(frames.every((frame) => !('agentId' in frame.body))).toBe(true);
    expect(frames.every((frame) => !('conversationId' in frame.body))).toBe(true);
    expect(frames[1]!.body.delta).toBe('hi');
  });

  it('maps orchestrator signals to stablehand.* CUSTOM frames on the run channel', () => {
    const projector = new CanonicalProjector();
    const interrupted = projector.project('interrupt.requested', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      toolCallId: 'tc-1', toolName: 'send_email', args: {}, interruptId: 'turn-1', timestamp: T,
    });
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toEqual(expect.objectContaining({ type: 'CUSTOM', channel: 'run', turnId: 'turn-1' }));
    expect(interrupted[0]!.body.name).toBe('stablehand.interrupt.requested');
    expect(interrupted[0]!.body.toolName).toBe('send_email');
    expect(interrupted[0]!.body).not.toHaveProperty('toolCallName');
    expect(interrupted[0]!.body).not.toHaveProperty('subtype');
    expect(interrupted[0]!.body).not.toHaveProperty('runId');
    expect(interrupted[0]!.body).not.toHaveProperty('threadId');
    expect(interrupted[0]!.body).not.toHaveProperty('value');

    const resolved = projector.project('interrupt.resolved', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      interruptId: 'interrupt-1', action: 'approve', timestamp: T,
    });
    expect(resolved[0]!.body.name).toBe('stablehand.interrupt.resolved');
    expect(resolved[0]!.body).not.toHaveProperty('subtype');

    const pending = projector.project('turn.pending', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1', mode: 'interactive', timestamp: T,
    });
    expect(pending[0]!.body.name).toBe('stablehand.turn.pending');
  });

  it('persists system and user-defined custom events verbatim (ADR-012 gates unchanged)', () => {
    const projector = new CanonicalProjector();

    const system = projector.project('agent.created', { agentId: 'agent-1', name: 'a', timestamp: T });
    expect(system[0]).toEqual(expect.objectContaining({ type: 'agent.created', channel: 'system' }));
    expect(system[0]!.body).toEqual({ agentId: 'agent-1', name: 'a', timestamp: T });
    expect(system[0]!.sourceType).toBe('agent.created');
    expect(JSON.parse(system[0]!.sourcePayload ?? '{}')).toEqual({ agentId: 'agent-1', name: 'a', timestamp: T });

    const custom = projector.project('stress.langgraph.complete', {
      agentId: 'agent-1', schemaVersion: 1, status: 'ok', harness: 'langgraph', timestamp: T,
    });
    expect(custom[0]).toEqual(expect.objectContaining({ type: 'stress.langgraph.complete', channel: 'custom' }));
    expect(custom[0]!.body.schemaVersion).toBe(1);
    expect(custom[0]!.sourceType).toBe('stress.langgraph.complete');
  });

  it('tags only the first frame projected from a raw bus event', () => {
    const projector = new CanonicalProjector();
    const payload = messageDelta('turn-1', 'hello');

    const frames = projector.project('message.delta', payload);

    expect(frames.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
    expect(frames[0]!.sourceType).toBe('message.delta');
    expect(JSON.parse(frames[0]!.sourcePayload ?? '{}')).toEqual(payload);
    expect(frames[1]!.sourceType).toBeUndefined();
    expect(frames[1]!.sourcePayload).toBeUndefined();
  });

  it('creates a provenance-only row for future run-channel events without a projector mapping', () => {
    const mutableRunEvents = RUN_CHANNEL_EVENTS as string[];
    mutableRunEvents.push('run.future_zero_frame');
    try {
      const projector = new CanonicalProjector();
      const frames = projector.project('run.future_zero_frame', {
        turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1', timestamp: T,
      });

      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual(expect.objectContaining({
        type: 'stablehand.raw_event',
        channel: 'system',
        sourceType: 'run.future_zero_frame',
      }));
    } finally {
      mutableRunEvents.pop();
    }
  });
});

describe('CanonicalProjector spend-cap stops (ctx-ycek)', () => {
  const STOP = {
    code: 'budget_reached' as const,
    source: 'run_limit' as const,
    capUsd: 0.05,
    spentUsd: 0.0512,
  };

  it('puts the typed stop on the RUN_ERROR frame and keeps it strictly parseable', () => {
    const projector = new CanonicalProjector();

    const frames = projector.project('turn.completed', {
      turnId: 'turn-1', sandboxSessionId: 'sandbox-1', agentId: 'agent-1', conversationId: 'conv-1',
      status: 'error', error: 'Stopped: this run reached its $0.05 spend cap.', stopReason: STOP,
      durationMs: 5, usage: null, timestamp: T,
    });
    const runError = frames.find((frame) => frame.type === 'RUN_ERROR');

    expect(runError?.body).toMatchObject({
      message: 'Stopped: this run reached its $0.05 spend cap.',
      code: 'budget_reached',
      stopReason: STOP,
    });
    expect(() => CanonicalStreamEventSchema.parse(runError?.body)).not.toThrow();
  });

  it('persists budget.reached verbatim on the system channel', () => {
    const projector = new CanonicalProjector();
    const payload = {
      turnId: 'turn-1',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      sandboxSessionId: 'sandbox-1',
      source: 'run_limit',
      capUsd: 0.05,
      spentUsd: 0.0512,
      timestamp: T,
    };

    const [frame] = projector.project('budget.reached', payload);

    expect(frame).toMatchObject({
      type: 'budget.reached',
      channel: 'system',
      agentId: 'agent-1',
      turnId: 'turn-1',
      conversationId: 'conv-1',
      body: payload,
    });
  });
});
