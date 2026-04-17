import { describe, it, expect, beforeEach } from 'vitest';
import {
  serializeCheckpoint,
  deserializeCheckpoint,
  validateCheckpointSize,
  SessionStateCollector,
  type SessionCheckpoint,
  type WorkspaceRef,
} from '../checkpoint.js';
import type { AgentEvent, HarnessExportedState } from '../../harness/types.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const WORKSPACE_NONE: WorkspaceRef = { strategy: 'none', reference: '' };
const WORKSPACE_TAR: WorkspaceRef = {
  strategy: 'tar',
  reference: 'data/checkpoints/sess-1/workspace.tar.gz',
};

function makeHarnessState(overrides?: Partial<HarnessExportedState>): HarnessExportedState {
  return {
    stateVersion: '1',
    payload: { transcript: [] },
    ...overrides,
  };
}

function makeMinimalCheckpoint(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
  return {
    checkpointVersion: 2,
    sessionId: 'sess-1',
    conversationId: 'conv-1',
    harnessName: 'pi-agent',
    cursor: { nextMessageSeq: 0 },
    runnerState: { status: 'IDLE' },
    workspaceRef: WORKSPACE_NONE,
    harnessState: makeHarnessState(),
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  serialize / deserialize round-trip                                         */
/* -------------------------------------------------------------------------- */

describe('serializeCheckpoint / deserializeCheckpoint', () => {
  it('round-trips a minimal checkpoint', () => {
    const original = makeMinimalCheckpoint();
    expect(deserializeCheckpoint(serializeCheckpoint(original))).toEqual(original);
  });

  it('round-trips a checkpoint with pending requests', () => {
    const original = makeMinimalCheckpoint({
      sessionId: 'sess-2',
      conversationId: 'conv-2',
      harnessName: 'claude-agents',
      cursor: { nextMessageSeq: 5, lastCompletedTurnId: 'turn-3' },
      runnerState: {
        status: 'WAITING_INPUT',
        pendingRequests: [
          { type: 'tool_call', id: 'tc-1', payload: { name: 'bash', args: { cmd: 'ls' } } },
          { type: 'approval', id: 'ap-1', payload: { tool: 'rm', args: { path: '/tmp' } } },
        ],
      },
      workspaceRef: WORKSPACE_TAR,
      harnessState: makeHarnessState({ stateVersion: '2', payload: { messages: ['a', 'b'] } }),
    });
    expect(deserializeCheckpoint(serializeCheckpoint(original))).toEqual(original);
  });

  it('produces valid JSON', () => {
    expect(() => JSON.parse(serializeCheckpoint(makeMinimalCheckpoint()))).not.toThrow();
  });

  it('sets checkpointVersion to 2', () => {
    const cp = makeMinimalCheckpoint();
    const parsed = JSON.parse(serializeCheckpoint(cp)) as { checkpointVersion: number };
    expect(parsed.checkpointVersion).toBe(2);
  });

  it('throws on unsupported version', () => {
    const json = serializeCheckpoint(makeMinimalCheckpoint()).replace(
      '"checkpointVersion":2',
      '"checkpointVersion":1',
    );
    expect(() => deserializeCheckpoint(json)).toThrow('Unsupported checkpoint version: 1. Expected: 2');
  });

  it('throws on version 99', () => {
    const json = serializeCheckpoint(makeMinimalCheckpoint()).replace(
      '"checkpointVersion":2',
      '"checkpointVersion":99',
    );
    expect(() => deserializeCheckpoint(json)).toThrow('Unsupported checkpoint version: 99');
  });

  it('throws on invalid JSON', () => {
    expect(() => deserializeCheckpoint('not json')).toThrow();
  });

  it('serializes bigint checkpoint payloads as strings without throwing', () => {
    const original = makeMinimalCheckpoint({
      runnerState: {
        status: 'WAITING_INPUT',
        pendingRequests: [
          {
            type: 'tool_call',
            id: 'tc-bigint',
            payload: {
              count: 9007199254740993n,
            },
          },
        ],
      },
      harnessState: makeHarnessState({
        payload: {
          checkpoints: [1n, 2n],
          nested: {
            seq: 9007199254740997n,
          },
        },
      }),
    });

    const json = serializeCheckpoint(original);

    expect(JSON.parse(json)).toEqual({
      checkpointVersion: 2,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      harnessName: 'pi-agent',
      cursor: { nextMessageSeq: 0 },
      runnerState: {
        status: 'WAITING_INPUT',
        pendingRequests: [
          {
            type: 'tool_call',
            id: 'tc-bigint',
            payload: {
              count: '9007199254740993',
            },
          },
        ],
      },
      workspaceRef: WORKSPACE_NONE,
      harnessState: {
        stateVersion: '1',
        payload: {
          checkpoints: ['1', '2'],
          nested: {
            seq: '9007199254740997',
          },
        },
      },
    });

    expect(deserializeCheckpoint(json)).toEqual({
      ...original,
      runnerState: {
        status: 'WAITING_INPUT',
        pendingRequests: [
          {
            type: 'tool_call',
            id: 'tc-bigint',
            payload: {
              count: '9007199254740993',
            },
          },
        ],
      },
      harnessState: {
        stateVersion: '1',
        payload: {
          checkpoints: ['1', '2'],
          nested: {
            seq: '9007199254740997',
          },
        },
      },
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  validateCheckpointSize                                                     */
/* -------------------------------------------------------------------------- */

describe('validateCheckpointSize', () => {
  it('passes for small checkpoints', () => {
    const json = serializeCheckpoint(makeMinimalCheckpoint());
    const result = validateCheckpointSize(json);
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sizeBytes).toBeLessThan(1024 * 1024);
    expect(result.warning).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('warns for checkpoints between 1 MB and 5 MB', () => {
    const largePayload = 'x'.repeat(1.5 * 1024 * 1024);
    const json = serializeCheckpoint(
      makeMinimalCheckpoint({ harnessState: makeHarnessState({ payload: { blob: largePayload } }) }),
    );
    const result = validateCheckpointSize(json);
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(1024 * 1024);
    expect(result.warning).toMatch('warning threshold');
    expect(result.error).toBeUndefined();
  });

  it('rejects checkpoints over 5 MB', () => {
    const hugePayload = 'x'.repeat(5.5 * 1024 * 1024);
    const json = serializeCheckpoint(
      makeMinimalCheckpoint({ harnessState: makeHarnessState({ payload: { blob: hugePayload } }) }),
    );
    const result = validateCheckpointSize(json);
    expect(result.ok).toBe(false);
    expect(result.sizeBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(result.error).toMatch('5 MB');
  });
});

/* -------------------------------------------------------------------------- */
/*  SessionStateCollector                                                      */
/* -------------------------------------------------------------------------- */

describe('SessionStateCollector', () => {
  let collector: SessionStateCollector;

  beforeEach(() => {
    collector = new SessionStateCollector();
  });

  it('produces IDLE checkpoint with no pending requests', () => {
    collector.startTurn('t-1');
    collector.endTurn();
    const cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.checkpointVersion).toBe(2);
    expect(cp.runnerState.status).toBe('IDLE');
    expect(cp.runnerState.pendingRequests).toBeUndefined();
  });

  it('startTurn sets the active turnId in cursor.lastCompletedTurnId when no endTurn', () => {
    collector.startTurn('t-active');
    const cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.cursor.lastCompletedTurnId).toBe('t-active');
  });

  it('endTurn clears the active turnId', () => {
    collector.startTurn('t-done');
    collector.endTurn();
    const cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.cursor.lastCompletedTurnId).toBeUndefined();
  });

  it('tracks tool_call_start and removes on tool_call_end', () => {
    const start: AgentEvent = { type: 'tool_call_start', id: 'tc-1', name: 'bash', args: { cmd: 'ls' } };
    collector.processTurnEvent(start);
    let cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.status).toBe('WAITING_INPUT');
    expect(cp.runnerState.pendingRequests).toHaveLength(1);
    expect(cp.runnerState.pendingRequests![0].type).toBe('tool_call');
    expect(cp.runnerState.pendingRequests![0].id).toBe('tc-1');

    const end: AgentEvent = { type: 'tool_call_end', id: 'tc-1', result: 'ok', durationMs: 50 };
    collector.processTurnEvent(end);
    cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.status).toBe('IDLE');
    expect(cp.runnerState.pendingRequests).toBeUndefined();
  });

  it('tracks approval_needed and removes on approval_resolved', () => {
    const needed: AgentEvent = { type: 'approval_needed', id: 'ap-1', tool: 'rm', args: { path: '/' } };
    collector.processTurnEvent(needed);
    let cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.status).toBe('WAITING_INPUT');
    expect(cp.runnerState.pendingRequests![0].type).toBe('approval');
    expect(cp.runnerState.pendingRequests![0].id).toBe('ap-1');

    const resolved: AgentEvent = { type: 'approval_resolved', id: 'ap-1', action: 'approve' };
    collector.processTurnEvent(resolved);
    cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.status).toBe('IDLE');
    expect(cp.runnerState.pendingRequests).toBeUndefined();
  });

  it('advances messageSeq on message_committed', () => {
    const committed: AgentEvent = {
      type: 'message_committed',
      role: 'assistant',
      content: 'Hello',
      turnId: 't-1',
      messageSeq: 3,
    };
    collector.processTurnEvent(committed);
    const cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.cursor.nextMessageSeq).toBe(4);
  });

  it('tracks multiple tool calls simultaneously', () => {
    const tcA: AgentEvent = { type: 'tool_call_start', id: 'tc-a', name: 'read', args: { path: '/a' } };
    const tcB: AgentEvent = { type: 'tool_call_start', id: 'tc-b', name: 'write', args: { path: '/b' } };
    collector.processTurnEvent(tcA);
    collector.processTurnEvent(tcB);

    let cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.pendingRequests).toHaveLength(2);

    collector.processTurnEvent({ type: 'tool_call_end', id: 'tc-a', result: 'data', durationMs: 10 });
    cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.pendingRequests).toHaveLength(1);
    expect(cp.runnerState.pendingRequests![0].id).toBe('tc-b');
    expect(cp.runnerState.status).toBe('WAITING_INPUT');

    collector.processTurnEvent({ type: 'tool_call_end', id: 'tc-b', result: 'ok', durationMs: 10 });
    cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.pendingRequests).toBeUndefined();
    expect(cp.runnerState.status).toBe('IDLE');
  });

  it('includes supplied harnessState and workspaceRef verbatim', () => {
    const harnessState = makeHarnessState({ stateVersion: '3', payload: { k: 'v' } });
    const cp = collector.getCheckpointSnapshot(
      'sess-42', 'conv-42', 'langgraph', harnessState, WORKSPACE_TAR,
    );
    expect(cp.sessionId).toBe('sess-42');
    expect(cp.conversationId).toBe('conv-42');
    expect(cp.harnessName).toBe('langgraph');
    expect(cp.harnessState).toEqual(harnessState);
    expect(cp.workspaceRef).toEqual(WORKSPACE_TAR);
  });

  it('returns independent pendingRequests array in snapshot', () => {
    const start: AgentEvent = { type: 'tool_call_start', id: 'tc-1', name: 'x', args: {} };
    collector.processTurnEvent(start);
    const cp1 = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    collector.processTurnEvent({ type: 'tool_call_end', id: 'tc-1', result: 'ok', durationMs: 1 });
    expect(cp1.runnerState.pendingRequests).toHaveLength(1);
  });

  it('accumulates messageSeq across multiple message_committed events', () => {
    collector.processTurnEvent({ type: 'message_committed', role: 'user', content: 'hi', turnId: 't-1', messageSeq: 0 });
    collector.processTurnEvent({ type: 'message_committed', role: 'assistant', content: 'hey', turnId: 't-1', messageSeq: 1 });
    const cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.cursor.nextMessageSeq).toBe(2);
  });

  it('ignores unrelated events (text_delta, done, error)', () => {
    collector.processTurnEvent({ type: 'text_delta', content: 'streaming...' });
    collector.processTurnEvent({ type: 'done', result: 'complete' });
    collector.processTurnEvent({ type: 'error', error: 'oops' });
    const cp = collector.getCheckpointSnapshot(
      'sess-1', 'conv-1', 'claude-agents', makeHarnessState(), WORKSPACE_NONE,
    );
    expect(cp.runnerState.status).toBe('IDLE');
    expect(cp.cursor.nextMessageSeq).toBe(0);
  });
});
