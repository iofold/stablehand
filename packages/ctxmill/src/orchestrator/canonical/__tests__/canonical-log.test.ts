import { describe, expect, it, vi } from 'vitest';

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
});
