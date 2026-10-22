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

interface RecordedFailure {
  triggerId: string;
  eventSeq: number;
  eventType: string;
  errorCode: string;
  error: string;
  attempts: number;
}

function createDurableTriggerHarness(runnerOptions: {
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
} = {}) {
  const rows: EventFrameRow[] = [];
  const cursors = new Map<string, number>();
  const triggerFirings = new Set<string>();
  const failures: RecordedFailure[] = [];
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
    recordTriggerFiringFailure: vi.fn(async (failure: RecordedFailure) => {
      const key = `${failure.triggerId}:${failure.eventSeq}`;
      if (triggerFirings.has(key)) {
        return undefined;
      }
      triggerFirings.add(key);
      failures.push(failure);
      return { id: `failed-${failure.eventSeq}`, status: 'failed', createdAt: Date.now(), ...failure };
    }),
  };
  const canonicalLog = new CanonicalLog({ db: db as never, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const eventBus = new TypedEventBus({
    persistEvent: async (type, _agentId, payload, parsedPayload, context) => {
      const persisted = await canonicalLog.ingest(
        type,
        parsedPayload ?? JSON.parse(payload) as Record<string, unknown>,
        context,
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
    ...runnerOptions,
  });
  return { db, eventBus, triggerManager, runner, onFire, cursors, failures, rows };
}

/** The error TurnStartupService throws for an interactive-only target (statusCode 409). */
function modeNotAllowedError(): Error {
  return Object.assign(
    new Error('Agent mode "interactive" does not allow background turns'),
    { code: 'agent_mode_not_allowed', statusCode: 409 },
  );
}

function queueFullError(): Error {
  return Object.assign(new Error('Turn queue is full for agent agent-1'), { code: 'queue_full', statusCode: 429 });
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

describe('SpineConsumerRunner bounded retries (ctx-v6ef)', () => {
  function createRetryHarness(
    rows: EventFrameRow[],
    consumer: SpineConsumer,
    options: { maxAttempts?: number; retryBaseDelayMs?: number; now?: () => number } = {},
  ) {
    const cursors = new Map<string, number>();
    const db = {
      getSpineCursor: vi.fn(async (name: string) => cursors.get(name) ?? 0),
      getSourceEventsSince: vi.fn(async (afterSeq: number) => rows.filter((row) => row.seq > afterSeq)),
      advanceSpineCursor: vi.fn(async (name: string, lastSeq: number) => {
        cursors.set(name, lastSeq);
        return { consumer: name, lastSeq, updatedAt: Date.now() };
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = new SpineConsumerRunner({
      canonicalLog: { subscribe: vi.fn(() => () => undefined) },
      db,
      consumers: [consumer],
      logger,
      rescanIntervalMs: 60_000,
      retryMaxDelayMs: 60_000,
      ...options,
    });
    return { runner, db, cursors, logger };
  }

  it('waits out the backoff instead of redelivering a failed event on every rescan', async () => {
    let now = 1_000_000;
    const handle = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const { runner, cursors } = createRetryHarness(
      [sourceRow(1)],
      { name: 'test', wants: () => true, handle },
      { retryBaseDelayMs: 30_000, now: () => now },
    );

    await runner.start();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(cursors.get('test')).toBeUndefined();

    now += 29_000;
    await runner.catchUpAll();
    expect(handle).toHaveBeenCalledTimes(1);

    now += 1_000;
    await runner.catchUpAll();
    expect(handle).toHaveBeenCalledTimes(2);
    expect(cursors.get('test')).toBe(1);
    runner.stop();
  });

  it('dead-letters a poison event after the attempt budget and catches up past it', async () => {
    const poison = new Error('always fails');
    const handle = vi.fn(async (event: { seq: number }) => {
      if (event.seq === 1) throw poison;
    });
    const deadLetter = vi.fn().mockResolvedValue(undefined);
    const { runner, cursors, logger } = createRetryHarness(
      [sourceRow(1), sourceRow(2)],
      { name: 'test', wants: () => true, handle, deadLetter },
      { maxAttempts: 3, retryBaseDelayMs: 1 },
    );

    await runner.start();
    await vi.waitFor(() => expect(cursors.get('test')).toBe(2));

    expect(handle.mock.calls.filter(([event]) => event.seq === 1)).toHaveLength(3);
    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(deadLetter).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }), poison, 3);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ seq: 2 }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gave up on seq 1'), poison);
    runner.stop();
  });

  it('holds the cursor when the dead letter itself cannot be recorded', async () => {
    const handle = vi.fn().mockRejectedValue(new Error('always fails'));
    const deadLetter = vi.fn().mockRejectedValue(new Error('db down'));
    const { runner, db } = createRetryHarness(
      [sourceRow(1)],
      { name: 'test', wants: () => true, handle, deadLetter },
      { maxAttempts: 1, retryBaseDelayMs: 60_000 },
    );

    await runner.start();

    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(db.advanceSpineCursor).not.toHaveBeenCalled();
    runner.stop();
  });

  it('keeps retrying, without skipping, consumers that have no dead-letter hook', async () => {
    const handle = vi.fn().mockRejectedValue(new Error('always fails'));
    const { runner, db } = createRetryHarness(
      [sourceRow(1)],
      { name: 'test', wants: () => true, handle },
      { maxAttempts: 1, retryBaseDelayMs: 1 },
    );

    await runner.start();
    await vi.waitFor(() => expect(handle.mock.calls.length).toBeGreaterThanOrEqual(3));

    expect(db.advanceSpineCursor).not.toHaveBeenCalled();
    runner.stop();
  });
});

describe('event-trigger consumer failure handling (ctx-v6ef)', () => {
  it('dead-letters a non-retryable firing on first delivery and keeps the spine moving', async () => {
    const { triggerManager, runner, onFire, cursors, failures, rows } = createDurableTriggerHarness();
    onFire.mockImplementation(async (agentId: string) => {
      if (agentId === 'interactive-agent') throw modeNotAllowedError();
    });
    await triggerManager.start();
    const poisonTrigger = await triggerManager.register({
      agentId: 'interactive-agent',
      eventType: 'custom.poison',
      taskTemplate: 'never runs',
      enabled: true,
    });
    await triggerManager.register({
      agentId: 'background-agent',
      eventType: 'custom.ready',
      taskTemplate: 'process {{payload.value}}',
      enabled: true,
    });
    await triggerManager.emitCustomEventAsync('custom.poison', 'agent-0', { value: 'x' });
    await triggerManager.emitCustomEventAsync('custom.ready', 'agent-0', { value: 'next' });

    await runner.start();

    expect(failures).toEqual([{
      triggerId: poisonTrigger.id,
      eventSeq: 1,
      eventType: 'custom.poison',
      errorCode: 'agent_mode_not_allowed',
      error: 'Agent mode "interactive" does not allow background turns',
      attempts: 1,
    }]);
    expect(onFire).toHaveBeenCalledWith('background-agent', 'process next', expect.any(String), 1, 2);
    expect(cursors.get('event-triggers')).toBeGreaterThanOrEqual(2);
    const notice = rows.find((row) => row.sourceType === 'trigger.failed');
    expect(JSON.parse(notice?.sourcePayload ?? '{}')).toMatchObject({
      triggerId: poisonTrigger.id,
      agentId: 'interactive-agent',
      eventType: 'custom.poison',
      eventSeq: 1,
      errorCode: 'agent_mode_not_allowed',
      attempts: 1,
      _triggerDepth: 1,
    });

    // Settled: a later rescan does not try the poison firing again.
    onFire.mockClear();
    await runner.catchUpAll();
    expect(onFire).not.toHaveBeenCalled();
    runner.stop();
  });

  it('retries a transient firing failure and fires once it recovers', async () => {
    const { triggerManager, runner, onFire, db, cursors, failures } = createDurableTriggerHarness({
      retryBaseDelayMs: 5,
    });
    onFire
      .mockRejectedValueOnce(queueFullError())
      .mockResolvedValue(undefined);
    await triggerManager.start();
    const trigger = await triggerManager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'process {{payload.value}}',
      enabled: true,
    });
    await triggerManager.emitCustomEventAsync('custom.ready', 'agent-0', { value: 'later' });

    await runner.start();
    expect(cursors.get('event-triggers')).toBeUndefined();

    await vi.waitFor(() => expect(cursors.get('event-triggers')).toBe(1));
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(db.recordTriggerFiring).toHaveBeenCalledWith(trigger.id, 1);
    expect(failures).toEqual([]);
    runner.stop();
  });

  it('dead-letters a firing whose retries run out, then catches up past it', async () => {
    const { triggerManager, runner, onFire, cursors, failures } = createDurableTriggerHarness({
      maxAttempts: 3,
      retryBaseDelayMs: 1,
    });
    onFire.mockImplementation(async (agentId: string) => {
      if (agentId === 'busy-agent') throw queueFullError();
    });
    await triggerManager.start();
    const busyTrigger = await triggerManager.register({
      agentId: 'busy-agent',
      eventType: 'custom.busy',
      taskTemplate: 'busy',
      enabled: true,
    });
    await triggerManager.register({
      agentId: 'idle-agent',
      eventType: 'custom.next',
      taskTemplate: 'next',
      enabled: true,
    });
    await triggerManager.emitCustomEventAsync('custom.busy', 'agent-0', {});
    await triggerManager.emitCustomEventAsync('custom.next', 'agent-0', {});

    await runner.start();
    await vi.waitFor(() => expect(cursors.get('event-triggers')).toBeGreaterThanOrEqual(2));

    expect(onFire.mock.calls.filter(([agentId]) => agentId === 'busy-agent')).toHaveLength(3);
    expect(failures).toEqual([expect.objectContaining({
      triggerId: busyTrigger.id,
      eventSeq: 1,
      errorCode: 'queue_full',
      error: 'Gave up after 3 attempts: Turn queue is full for agent agent-1',
      attempts: 3,
    })]);
    expect(onFire).toHaveBeenCalledWith('idle-agent', 'next', expect.any(String), 1, 2);
    runner.stop();
  });
});
