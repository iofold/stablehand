import { describe, expect, it, vi } from 'vitest';

import type { EventMap, EventName } from '../../../events/bus.js';
import { KNOWN_BUS_EVENT_NAMES } from '../frames.js';
import { CanonicalLog } from '../canonical-log.js';

function createDeps() {
  let nextSeq = 100;
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    saveEventBatch: vi.fn(async (frames: Array<Record<string, unknown>>) => {
      const seqs = frames.map(() => ++nextSeq);
      frames.forEach((frame, index) => rows.push({ ...frame, seq: seqs[index], createdAt: Date.now() }));
      return seqs;
    }),
    getFramesSince: vi.fn(async (agentId: string, afterSeq: number) =>
      rows.filter((row) => row.agentId === agentId && (row.seq as number) > afterSeq)),
    getTurnFrames: vi.fn(async (turnId: string) => rows.filter((row) => row.turnId === turnId)),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { db, logger, rows };
}

const CHUNK = {
  turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
  messageId: 'sandbox-msg', content: 'hello', timestamp: 1_000,
};

const EVENT_MAP_SAMPLES: { [K in EventName]: EventMap[K] } = {
  'turn.started': {
    turnId: 'turn-1',
    sessionId: 'session-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    mode: 'interactive',
    taskDescription: 'hello',
    timestamp: 1_000,
  },
  'run.text_chunk': CHUNK,
  'run.tool_started': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { cmd: 'pwd' },
    timestamp: 1_000,
  },
  'run.tool_result': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    toolCallId: 'tool-1',
    toolName: 'bash',
    result: 'ok',
    durationMs: 5,
    timestamp: 1_000,
  },
  'run.interrupted': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { cmd: 'deploy' },
    interruptId: 'interrupt-1',
    timestamp: 1_000,
  },
  'run.interrupt_resolved': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    interruptId: 'interrupt-1',
    action: 'approve',
    timestamp: 1_000,
  },
  'turn.completed': {
    turnId: 'turn-1',
    sessionId: 'session-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    status: 'completed',
    durationMs: 10,
    timestamp: 1_000,
  },
  'feedback.received': {
    feedbackId: 'feedback-1',
    turnId: 'turn-1',
    agentId: 'agent-1',
    type: 'thumbs_up',
    timestamp: 1_000,
  },
  'agent.created': {
    agentId: 'agent-1',
    name: 'agent',
    timestamp: 1_000,
  },
  'agent.deleted': {
    agentId: 'agent-1',
    timestamp: 1_000,
  },
  'client.connected': {
    agentId: 'agent-1',
    clientId: 'client-1',
    timestamp: 1_000,
  },
  'client.disconnected': {
    agentId: 'agent-1',
    clientId: 'client-1',
    timestamp: 1_000,
  },
  'run.resumed': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    triggeredBy: 'restore',
    suspendedDurationMs: 250,
    timestamp: 1_000,
  },
  'trigger.fired': {
    triggerId: 'trigger-1',
    agentId: 'agent-1',
    eventType: 'turn.completed',
    turnId: 'turn-1',
    timestamp: 1_000,
  },
  'message.committed': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    messageId: 'message-1',
    messageSeq: 1,
    role: 'assistant',
    content: 'done',
    timestamp: 1_000,
  },
  'turn.pending': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    mode: 'interactive',
    taskDescription: 'hello',
    timestamp: 1_000,
  },
  'run.ag_ui_event': {
    turnId: 'turn-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    event: { type: 'STATE_DELTA', delta: [] },
    timestamp: 1_000,
  },
  'user.message': {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    messageId: 'user-message-1',
    content: 'hello',
    timestamp: 1_000,
  },
  custom: {
    type: 'stress.langgraph.complete',
    agentId: 'agent-1',
    payload: { status: 'ok' },
    timestamp: 1_000,
  },
};

describe('CanonicalLog (ADR-015)', () => {
  it('persists before fan-out and hands subscribers seq-stamped frames (ADR-006)', async () => {
    const deps = createDeps();
    const log = new CanonicalLog(deps as never);
    const order: string[] = [];
    deps.db.saveEventBatch.mockImplementationOnce(async (frames: Array<Record<string, unknown>>) => {
      order.push('persist');
      return frames.map((_f, index) => 200 + index);
    });
    log.subscribe(() => order.push('fanout'));

    const persisted = await log.ingest('run.text_chunk', CHUNK);

    expect(order).toEqual(['persist', 'fanout']);
    expect(persisted.map((frame) => frame.seq)).toEqual([200, 201]);
    expect(persisted.map((frame) => frame.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
  });

  it('isolates subscriber failures', async () => {
    const deps = createDeps();
    const log = new CanonicalLog(deps as never);
    const seen: number[] = [];
    log.subscribe(() => { throw new Error('bad subscriber'); });
    log.subscribe((frames) => seen.push(frames.length));

    await log.ingest('run.text_chunk', CHUNK);

    expect(seen).toEqual([2]);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('replays frames by agent seq and by turn tail', async () => {
    const deps = createDeps();
    const log = new CanonicalLog(deps as never);
    await log.ingest('run.text_chunk', CHUNK);
    await log.ingest('turn.completed', {
      turnId: 'turn-1', sessionId: 's', agentId: 'agent-1', conversationId: 'conv-1',
      status: 'completed', durationMs: 1, timestamp: 2_000,
    });

    const all = await log.replaySince('agent-1', 0);
    expect(all.map((frame) => frame.type)).toEqual([
      'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED',
    ]);
    expect(all[0]!.body.messageId).toBe('turn-1-m1');

    const tail = await log.replayTurnTail('turn-1');
    expect(tail).toHaveLength(4);

    const afterFirst = await log.replaySince('agent-1', all[0]!.seq);
    expect(afterFirst).toHaveLength(3);
  });

  it('returns nothing to persist for unmapped events', async () => {
    const deps = createDeps();
    const log = new CanonicalLog(deps as never);
    const persisted = await log.ingest('run.ag_ui_event', {
      turnId: 'turn-1', agentId: 'agent-1', conversationId: 'conv-1',
      event: { type: 'STATE_DELTA', delta: [] }, timestamp: 1,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.type).toBe('STATE_DELTA');
  });

  it('persists exactly one source-bearing row for every EventMap event', async () => {
    expect(new Set(Object.keys(EVENT_MAP_SAMPLES))).toEqual(new Set(KNOWN_BUS_EVENT_NAMES));

    for (const eventName of KNOWN_BUS_EVENT_NAMES as EventName[]) {
      const deps = createDeps();
      const log = new CanonicalLog(deps as never);
      const payload = EVENT_MAP_SAMPLES[eventName] as Record<string, unknown>;

      const persisted = await log.ingest(eventName, payload);
      const sourceRows = deps.rows.filter((row) => row.sourceType === eventName);

      expect(persisted.length, eventName).toBeGreaterThanOrEqual(1);
      expect(sourceRows, eventName).toHaveLength(1);
      expect(JSON.parse(sourceRows[0]!.sourcePayload as string), eventName).toEqual(payload);
      expect(persisted.filter((frame) => frame.sourceType === eventName), eventName).toHaveLength(1);
    }
  });
});
