import { describe, expect, it } from 'vitest';

import { CanonicalProjector } from '../projector.js';

const T = 1_000;

function textChunk(turnId: string, content: string, messageId = 'sandbox-msg') {
  return { turnId, agentId: 'agent-1', conversationId: 'conv-1', messageId, content, timestamp: T };
}

describe('CanonicalProjector (ADR-015)', () => {
  it('synthesizes stable assistant message boundaries per turn', () => {
    const projector = new CanonicalProjector();

    const first = projector.project('run.text_chunk', textChunk('turn-1', 'Hel'));
    expect(first.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
    expect(first[0]!.body.messageId).toBe('turn-1-m1');

    const second = projector.project('run.text_chunk', textChunk('turn-1', 'lo'));
    expect(second.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_CONTENT']);
    expect(second[0]!.body.messageId).toBe('turn-1-m1');
    expect(second[0]!.body.delta).toBe('lo');

    // Tool start closes the message; the next chunk opens turn-1-m2.
    const toolFrames = projector.project('run.tool_started', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      toolCallId: 'tc-1', toolName: 'bash', args: { cmd: 'ls' }, timestamp: T,
    });
    expect(toolFrames.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_END', 'TOOL_CALL_START', 'TOOL_CALL_ARGS']);
    expect(toolFrames[0]!.body.messageId).toBe('turn-1-m1');

    const third = projector.project('run.text_chunk', textChunk('turn-1', 'done'));
    expect(third[0]!.body.messageId).toBe('turn-1-m2');
  });

  it('keeps message boundaries independent across concurrent turns', () => {
    const projector = new CanonicalProjector();
    projector.project('run.text_chunk', textChunk('turn-a', 'x'));
    const other = projector.project('run.text_chunk', textChunk('turn-b', 'y'));
    expect(other[0]!.body.messageId).toBe('turn-b-m1');
  });

  it('closes open text and emits spec RUN_ERROR message on failed turn completion', () => {
    const projector = new CanonicalProjector();
    projector.project('run.text_chunk', textChunk('turn-1', 'partial'));

    const frames = projector.project('turn.completed', {
      turnId: 'turn-1', sessionId: 'sess-1', agentId: 'agent-1', conversationId: 'conv-1',
      status: 'error', error: 'boom', durationMs: 5, timestamp: T,
    });

    expect(frames.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_END', 'RUN_ERROR', 'RUN_FINISHED']);
    expect(frames[1]!.body.message).toBe('boom');
    expect(frames[2]!.body.status).toBe('error');
  });

  it('detects a2ui-render results and emits a replayable CUSTOM frame', () => {
    const projector = new CanonicalProjector();
    const frames = projector.project('run.tool_result', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      toolCallId: 'tc-1', toolName: 'a2ui-render',
      result: JSON.stringify({ component: 'Chart', props: { series: [1] } }),
      timestamp: T,
    });

    expect(frames.map((frame) => frame.type)).toEqual(['TOOL_CALL_END', 'TOOL_CALL_RESULT', 'CUSTOM']);
    expect(frames[2]!.body.name).toBe('ctxmill.a2ui.render');
    expect(frames[2]!.body.block).toEqual({ id: 'tc-1', component: 'Chart', props: { series: [1] } });
  });

  it('projects user messages as a full triplet keyed to the conversation', () => {
    const projector = new CanonicalProjector();
    const frames = projector.project('user.message', {
      agentId: 'agent-1', conversationId: 'conv-1', messageId: 'msg-9', content: 'hi', timestamp: T,
    });
    expect(frames.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
    expect(frames.every((frame) => frame.body.role === 'user')).toBe(true);
    expect(frames[1]!.body.delta).toBe('hi');
  });

  it('maps orchestrator signals to ctxmill.* CUSTOM frames on the run channel', () => {
    const projector = new CanonicalProjector();
    const interrupted = projector.project('run.interrupted', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      toolCallId: 'tc-1', toolName: 'send_email', args: {}, interruptId: 'turn-1', timestamp: T,
    });
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toEqual(expect.objectContaining({ type: 'CUSTOM', channel: 'run', turnId: 'turn-1' }));
    expect(interrupted[0]!.body.name).toBe('ctxmill.hitl.requested');

    const pending = projector.project('turn.pending', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1', mode: 'interactive', timestamp: T,
    });
    expect(pending[0]!.body.name).toBe('ctxmill.turn.pending');
  });

  it('persists system and user-defined custom events verbatim (ADR-012 gates unchanged)', () => {
    const projector = new CanonicalProjector();

    const system = projector.project('agent.created', { agentId: 'agent-1', name: 'a', timestamp: T });
    expect(system[0]).toEqual(expect.objectContaining({ type: 'agent.created', channel: 'system' }));
    expect(system[0]!.body).toEqual({ agentId: 'agent-1', name: 'a', timestamp: T });

    const custom = projector.project('stress.langgraph.complete', {
      agentId: 'agent-1', schemaVersion: 1, status: 'ok', harness: 'langgraph', timestamp: T,
    });
    expect(custom[0]).toEqual(expect.objectContaining({ type: 'stress.langgraph.complete', channel: 'custom' }));
    expect(custom[0]!.body.schemaVersion).toBe(1);
  });
});
