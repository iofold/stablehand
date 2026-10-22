import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../bus.js';
import { EventTriggerManager, TriggerConflictError } from '../trigger-manager.js';
import { RetryableTriggerFireError } from '../trigger-errors.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { SpineRawEvent } from '../spine-consumer-runner.js';

function createDbMock() {
  return {
    getTriggers: vi.fn().mockResolvedValue([]),
    saveTrigger: vi.fn().mockImplementation(async (data) => data),
    deleteTrigger: vi.fn().mockResolvedValue(undefined),
    getTriggerBySignature: vi.fn().mockResolvedValue(undefined),
    hasTriggerFiring: vi.fn().mockResolvedValue(false),
    recordTriggerFiring: vi.fn().mockResolvedValue({ id: 'firing-1' }),
    recordTriggerFiringFailure: vi.fn().mockResolvedValue({ id: 'failed-1' }),
  } as unknown as DatabaseRepository & {
    getTriggers: ReturnType<typeof vi.fn>;
    saveTrigger: ReturnType<typeof vi.fn>;
    deleteTrigger: ReturnType<typeof vi.fn>;
    getTriggerBySignature: ReturnType<typeof vi.fn>;
    hasTriggerFiring: ReturnType<typeof vi.fn>;
    recordTriggerFiring: ReturnType<typeof vi.fn>;
    recordTriggerFiringFailure: ReturnType<typeof vi.fn>;
  };
}

function createManager(db = createDbMock()) {
  const bus = new TypedEventBus();
  const onFire = vi.fn().mockResolvedValue(undefined);
  return {
    bus,
    db,
    onFire,
    manager: new EventTriggerManager(bus, db, onFire),
  };
}

function rawEvent(overrides: Partial<SpineRawEvent> = {}): SpineRawEvent {
  return {
    seq: 42,
    sourceType: 'custom.ready',
    sourcePayload: JSON.stringify({ type: 'custom.ready', agentId: 'agent-0', payload: { ok: true }, timestamp: 1_000 }),
    payload: { type: 'custom.ready', agentId: 'agent-0', payload: { ok: true }, ok: true, value: 'abc', timestamp: 1_000 },
    agentId: 'agent-0',
    turnId: null,
    conversationId: null,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('EventTriggerManager durable mutations', () => {
  it('rejects malformed custom events at the shared internal choke point', async () => {
    const { bus, manager } = createManager();
    const emit = vi.spyOn(bus, 'emitCustomAsync');

    await expect(manager.emitCustomEventAsync(
      'turn.completed',
      undefined,
      {},
    )).rejects.toThrow();
    await expect(manager.emitCustomEventAsync(
      'custom.oversized',
      undefined,
      { content: 'x'.repeat(257 * 1024) },
    )).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

  it('stamps scoped HTTP key provenance outside the caller payload', async () => {
    const { bus, manager } = createManager();
    const emit = vi.spyOn(bus, 'emitCustomAsync').mockResolvedValue(undefined);

    await manager.emitCustomEventAsync(
      'custom.gallery.published',
      'agent-1',
      { artifactId: 'artifact-1' },
      { keyId: 'key_gallery' },
    );

    expect(emit).toHaveBeenCalledWith(
      'custom.gallery.published',
      'agent-1',
      expect.objectContaining({
        keyId: 'key_gallery',
        payload: { artifactId: 'artifact-1' },
      }),
    );
    expect(emit.mock.calls[0]?.[2]).not.toHaveProperty('payload.keyId');
  });

  it('does not add a trigger to memory when DB registration fails', async () => {
    const db = createDbMock();
    db.saveTrigger.mockRejectedValueOnce(new Error('db unavailable'));
    const { manager } = createManager(db);

    await expect(manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      selector: { ok: true },
      taskTemplate: 'Run',
      enabled: true,
    })).rejects.toThrow('db unavailable');

    expect(manager.list()).toEqual([]);
  });

  it('does not update memory when DB update fails', async () => {
    const { manager, db } = createManager();
    const trigger = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'Original',
      enabled: true,
    });
    db.saveTrigger.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(manager.update(trigger.id, { taskTemplate: 'Changed' })).rejects.toThrow('db unavailable');

    expect(manager.get(trigger.id)?.taskTemplate).toBe('Original');
  });

  it('does not remove memory when DB delete fails', async () => {
    const { manager, db } = createManager();
    const trigger = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'Original',
      enabled: true,
    });
    db.deleteTrigger.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(manager.unregister(trigger.id)).rejects.toThrow('db unavailable');

    expect(manager.get(trigger.id)).toEqual(trigger);
  });

  it('rejects updates that collide with an existing in-memory signature', async () => {
    const { manager } = createManager();
    const first = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      selector: { b: 2, a: 1 },
      taskTemplate: 'First',
      enabled: true,
    });
    const second = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.other',
      selector: { a: 1, b: 2 },
      taskTemplate: 'Second',
      enabled: true,
    });

    await expect(manager.update(second.id, { eventType: 'custom.ready' })).rejects.toBeInstanceOf(TriggerConflictError);

    expect(manager.get(first.id)?.eventType).toBe('custom.ready');
    expect(manager.get(second.id)?.eventType).toBe('custom.other');
  });

  it('fires matching raw spine events and records the event seq after the run starts', async () => {
    const { manager, db, onFire } = createManager();
    const trigger = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      selector: { ok: true },
      taskTemplate: 'process {{payload.value}}',
      enabled: true,
    });

    await manager.handleRawEvent(rawEvent());

    expect(onFire).toHaveBeenCalledWith('agent-1', 'process abc', trigger.id, 1, 42);
    expect(db.recordTriggerFiring).toHaveBeenCalledWith(trigger.id, 42);
  });

  it('skips raw spine events that already have a trigger firing row', async () => {
    const { manager, db, onFire } = createManager();
    db.hasTriggerFiring.mockResolvedValue(true);
    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'process',
      enabled: true,
    });

    await manager.handleRawEvent(rawEvent());

    expect(onFire).not.toHaveBeenCalled();
    expect(db.recordTriggerFiring).not.toHaveBeenCalled();
  });

  it('retires a target while a spine lookup is pending and prevents its run', async () => {
    const { manager, db, onFire } = createManager();
    let releaseLookup!: (alreadyFired: boolean) => void;
    db.hasTriggerFiring.mockReturnValueOnce(new Promise((resolve) => {
      releaseLookup = resolve;
    }));
    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'process',
      enabled: true,
    });

    const handling = manager.handleRawEvent(rawEvent());
    await vi.waitFor(() => expect(db.hasTriggerFiring).toHaveBeenCalledOnce());
    await manager.stopForAgent('agent-1');
    releaseLookup(false);
    await handling;

    expect(manager.list('agent-1')).toEqual([]);
    expect(onFire).not.toHaveBeenCalled();
    expect(db.recordTriggerFiring).not.toHaveBeenCalled();
  });

  it('does not admit another target run after retirement while a prior callback finishes', async () => {
    const { manager, db, onFire } = createManager();
    let releaseFire!: () => void;
    onFire.mockReturnValueOnce(new Promise<void>((resolve) => {
      releaseFire = resolve;
    }));
    await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'process',
      enabled: true,
    });

    const handling = manager.handleRawEvent(rawEvent());
    await vi.waitFor(() => expect(onFire).toHaveBeenCalledOnce());
    await manager.stopForAgent('agent-1');
    releaseFire();
    await handling;

    expect(db.recordTriggerFiring).toHaveBeenCalledWith(expect.any(String), 42);
    await manager.handleRawEvent(rawEvent({ seq: 43 }));
    expect(onFire).toHaveBeenCalledOnce();
  });

  it('settles a non-retryable firing as a dead letter instead of holding the cursor', async () => {
    const { manager, db, onFire, bus } = createManager();
    const notices: unknown[] = [];
    bus.on('trigger.failed', (payload) => {
      notices.push(payload);
    });
    onFire.mockRejectedValueOnce(Object.assign(
      new Error('Agent mode "interactive" does not allow background turns'),
      { code: 'agent_mode_not_allowed' },
    ));
    const trigger = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'process',
      enabled: true,
    });

    await expect(manager.handleRawEvent(rawEvent())).resolves.toBeUndefined();

    expect(db.recordTriggerFiring).not.toHaveBeenCalled();
    expect(db.recordTriggerFiringFailure).toHaveBeenCalledWith({
      triggerId: trigger.id,
      eventSeq: 42,
      eventType: 'custom.ready',
      errorCode: 'agent_mode_not_allowed',
      error: 'Agent mode "interactive" does not allow background turns',
      attempts: 1,
    });
    await vi.waitFor(() => expect(notices).toEqual([expect.objectContaining({
      triggerId: trigger.id,
      agentId: 'agent-1',
      eventSeq: 42,
      errorCode: 'agent_mode_not_allowed',
    })]));
  });

  it('rethrows retryable firing failures so the spine runner retries them', async () => {
    const { manager, db, onFire } = createManager();
    onFire.mockRejectedValueOnce(Object.assign(new Error('queue full'), { code: 'queue_full' }));
    const trigger = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'process',
      enabled: true,
    });

    const failure = await manager.handleRawEvent(rawEvent()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(RetryableTriggerFireError);
    expect((failure as RetryableTriggerFireError).failures).toEqual([{
      triggerId: trigger.id,
      agentId: 'agent-1',
      failure: { retryable: true, code: 'queue_full', message: 'queue full' },
    }]);
    expect(db.recordTriggerFiringFailure).not.toHaveBeenCalled();
  });

  it('dead-letters only the triggers that have not settled when retries run out', async () => {
    const { manager, db } = createManager();
    const settled = await manager.register({
      agentId: 'agent-1',
      eventType: 'custom.ready',
      taskTemplate: 'done already',
      enabled: true,
    });
    const pending = await manager.register({
      agentId: 'agent-2',
      eventType: 'custom.ready',
      taskTemplate: 'still failing',
      enabled: true,
    });
    db.hasTriggerFiring.mockImplementation(async (triggerId: string) => triggerId === settled.id);
    const error = new RetryableTriggerFireError('custom.ready', 42, [{
      triggerId: pending.id,
      agentId: 'agent-2',
      failure: { retryable: true, code: 'queue_full', message: 'queue full' },
    }]);

    await manager.deadLetterRawEvent(rawEvent(), error, 8);

    expect(db.recordTriggerFiringFailure).toHaveBeenCalledTimes(1);
    expect(db.recordTriggerFiringFailure).toHaveBeenCalledWith({
      triggerId: pending.id,
      eventSeq: 42,
      eventType: 'custom.ready',
      errorCode: 'queue_full',
      error: 'Gave up after 8 attempts: queue full',
      attempts: 8,
    });
  });
});
