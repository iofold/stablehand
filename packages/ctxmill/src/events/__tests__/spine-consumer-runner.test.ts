import { describe, expect, it, vi } from 'vitest';

import type { EventFrameRow } from '../../database/repository.js';
import { SpineConsumerRunner, type SpineConsumer } from '../spine-consumer-runner.js';
import type { PersistedFrame } from '../../orchestrator/canonical/frames.js';
import { CanonicalLog } from '../../orchestrator/canonical/canonical-log.js';
import { TypedEventBus } from '../bus.js';
import { createTriggerSpineConsumer, EventTriggerManager } from '../trigger-manager.js';
import type { DatabaseRepository } from '../../database/repository.js';

function sourceRow(seq: number, sourceType = 'custom.ready'): EventFrameRow {
  return {
    seq,
    type: sourceType,
    agentId: 'agent-1',
    payload: '{}',
    createdAt: 1_000 + seq,
    turnId: null,
    conversationId: null,
    channel: 'custom',
    sourceType,
    sourcePayload: JSON.stringify({ type: sourceType, agentId: 'agent-1', payload: { ok: true }, timestamp: 1_000 }),
  };
}

function createHarness(rows: EventFrameRow[], consumer: SpineConsumer) {
  let subscriber: ((frames: PersistedFrame[]) => void) | undefined;
  const db = {
    getSpineCursor: vi.fn(async () => 0),
    getSourceEventsSince: vi.fn(async (afterSeq: number) => rows.filter((row) => row.seq > afterSeq)),
    advanceSpineCursor: vi.fn(async (_name: string, lastSeq: number) => ({ consumer: 'test', lastSeq, updatedAt: Date.now() })),
  };
  const runner = new SpineConsumerRunner({
    canonicalLog: {
      subscribe: vi.fn((cb: (frames: PersistedFrame[]) => void) => {
        subscriber = cb;
        return () => { subscriber = undefined; };
      }),
    },
    db,
    consumers: [consumer],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rescanIntervalMs: 60_000,
    batchSize: 100,
  } as never);
  return { runner, db, emitLive: (frame: PersistedFrame) => subscriber?.([frame]) };
}

function createDurableTriggerHarness() {
  const rows: EventFrameRow[] = [];
  const cursors = new Map<string, number>();
  const triggerFirings = new Set<string>();
  let seq = 0;
  const persistFrames = async (
    frames: Array<Omit<EventFrameRow, 'seq' | 'createdAt'>>,
  ) => frames.map((frame) => {
    seq += 1;
    rows.push({
      ...frame,
      seq,
      createdAt: 1_000 + seq,
      turnId: frame.turnId ?? null,
      conversationId: frame.conversationId ?? null,
      sourceType: frame.sourceType ?? null,
      sourcePayload: frame.sourcePayload ?? null,
    });
    return seq;
  });
  const db = {
    saveEventBatch: vi.fn(persistFrames),
    saveTerminalEventBatch: vi.fn(persistFrames),
    getFramesSince: vi.fn(async () => []),
    getTurnFrames: vi.fn(async () => []),
    getSourceEventsSince: vi.fn(async (afterSeq: number, limit = 1_000) =>
      rows
        .filter((row) => row.seq > afterSeq && row.sourceType)
        .slice(0, limit)),
    getSpineCursor: vi.fn(async (consumer: string) => cursors.get(consumer) ?? 0),
    advanceSpineCursor: vi.fn(async (consumer: string, lastSeq: number) => {
      const nextSeq = Math.max(cursors.get(consumer) ?? 0, lastSeq);
      cursors.set(consumer, nextSeq);
      return { consumer, lastSeq: nextSeq, updatedAt: Date.now() };
    }),
    getTriggers: vi.fn(async () => []),
    saveTrigger: vi.fn(async (trigger) => trigger),
    deleteTrigger: vi.fn(async () => undefined),
    getTriggerBySignature: vi.fn(async () => undefined),
    hasTriggerFiring: vi.fn(async (triggerId: string, eventSeq: number) =>
      triggerFirings.has(`${triggerId}:${eventSeq}`)),
    recordTriggerFiring: vi.fn(async (triggerId: string, eventSeq: number) => {
      const key = `${triggerId}:${eventSeq}`;
      if (triggerFirings.has(key)) {
        return undefined;
      }
      triggerFirings.add(key);
      return { id: `firing-${eventSeq}`, triggerId, eventSeq, createdAt: Date.now() };
    }),
  };
  const canonicalLog = new CanonicalLog({ db: db as never, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const eventBus = new TypedEventBus({
    persistEvent: async (type, _agentId, payload, parsedPayload) => {
      const persisted = await canonicalLog.ingest(
        type,
        parsedPayload ?? JSON.parse(payload) as Record<string, unknown>,
      );
      return persisted.length > 0;
    },
  });
  const onFire = vi.fn().mockResolvedValue(undefined);
  const triggerManager = new EventTriggerManager(eventBus, db as unknown as DatabaseRepository, onFire);
  const runner = new SpineConsumerRunner({
    canonicalLog,
    db: db as unknown as DatabaseRepository,
    consumers: [createTriggerSpineConsumer(triggerManager)],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rescanIntervalMs: 60_000,
  });
  return { db, eventBus, triggerManager, runner, onFire, cursors };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SpineConsumerRunner', () => {
  it('delivers live source frames without advancing durable cursors', async () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    const consumer: SpineConsumer = { name: 'test', wants: () => true, handle };
    const { runner, db, emitLive } = createHarness([], consumer);
    await runner.start();

    emitLive({ ...sourceRow(10), body: {}, channel: 'custom' } as PersistedFrame);
    await Promise.resolve();

    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ seq: 10, sourceType: 'custom.ready' }));
    expect(db.advanceSpineCursor).not.toHaveBeenCalled();
    runner.stop();
  });

  it('advances a consumer cursor only after ordered catch-up handling succeeds', async () => {
    const handle = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('handler down'));
    const consumer: SpineConsumer = { name: 'test', wants: () => true, handle };
    const { runner, db } = createHarness([sourceRow(1), sourceRow(2)], consumer);

    await runner.start();

    expect(handle).toHaveBeenCalledTimes(2);
    expect(db.advanceSpineCursor).toHaveBeenCalledTimes(1);
    expect(db.advanceSpineCursor).toHaveBeenCalledWith('test', 1);
    runner.stop();
  });

  it('advances past source events a consumer does not want', async () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    const consumer: SpineConsumer = {
      name: 'test',
      wants: (sourceType) => sourceType === 'turn.completed',
      handle,
    };
    const { runner, db } = createHarness([sourceRow(1, 'custom.ready')], consumer);

    await runner.start();

    expect(handle).not.toHaveBeenCalled();
    expect(db.advanceSpineCursor).toHaveBeenCalledWith('test', 1);
    runner.stop();
  });

  it('routes live custom events through the trigger spine consumer without moving the cursor', async () => {
    const { triggerManager, runner, onFire, db, cursors } = createDurableTriggerHarness();
    await triggerManager.start();
    const trigger = await triggerManager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      selector: { ok: true },
      taskTemplate: 'process {{payload.value}}',
      enabled: true,
    });
    await runner.start();

    await triggerManager.emitCustomEventAsync('custom.ready', 'agent-1', { ok: true, value: 'live' });
    await flushMicrotasks();

    expect(onFire).toHaveBeenCalledWith('agent-1', 'process live', trigger.id, 1, 1);
    expect(db.recordTriggerFiring).toHaveBeenCalledWith(trigger.id, 1);
    expect(cursors.get('event-triggers')).toBeUndefined();
    runner.stop();
  });

  it('catches up missed custom events from the durable spine after restart', async () => {
    const { triggerManager, runner, onFire, db, cursors } = createDurableTriggerHarness();
    await triggerManager.start();
    const trigger = await triggerManager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      selector: { ok: true },
      taskTemplate: 'process {{payload.value}}',
      enabled: true,
    });

    await triggerManager.emitCustomEventAsync('custom.ready', 'agent-1', { ok: true, value: 'missed' });
    await flushMicrotasks();
    expect(onFire).not.toHaveBeenCalled();

    await runner.start();

    expect(onFire).toHaveBeenCalledWith('agent-1', 'process missed', trigger.id, 1, 1);
    expect(db.advanceSpineCursor).toHaveBeenCalledWith('event-triggers', 1);
    expect(cursors.get('event-triggers')).toBe(1);
    runner.stop();
  });
});
