import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../bus.js';
import { EventTriggerManager, TriggerConflictError } from '../trigger-manager.js';
import type { DatabaseRepository } from '../../database/repository.js';

function createDbMock() {
  return {
    getTriggers: vi.fn().mockResolvedValue([]),
    saveTrigger: vi.fn().mockImplementation(async (data) => data),
    deleteTrigger: vi.fn().mockResolvedValue(undefined),
    getTriggerBySignature: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseRepository & {
    getTriggers: ReturnType<typeof vi.fn>;
    saveTrigger: ReturnType<typeof vi.fn>;
    deleteTrigger: ReturnType<typeof vi.fn>;
    getTriggerBySignature: ReturnType<typeof vi.fn>;
  };
}

function createManager(db = createDbMock()) {
  const bus = new TypedEventBus();
  const onFire = vi.fn().mockResolvedValue(undefined);
  return {
    db,
    manager: new EventTriggerManager(bus, db, onFire),
  };
}

describe('EventTriggerManager durable mutations', () => {
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
});
