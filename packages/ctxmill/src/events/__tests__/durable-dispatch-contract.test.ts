import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus, type EventMap } from '../bus.js';
import { EventTriggerManager } from '../trigger-manager.js';
import type { DatabaseRepository } from '../../database/repository.js';

function agentCreatedPayload(overrides: Partial<EventMap['agent.created']> = {}): EventMap['agent.created'] {
  return {
    agentId: 'agent-1',
    name: 'Agent One',
    timestamp: Date.now(),
    ...overrides,
  };
}

function customTriggerDbMock() {
  return {
    getTriggers: vi.fn().mockResolvedValue([]),
    saveTrigger: vi.fn().mockResolvedValue(undefined),
    deleteTrigger: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseRepository;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// These executable specs capture the Stage 3 durable-event contract. They stay skipped
// until worker-2's Stage 2 lifecycle boundary is accepted, because behavior edits are
// intentionally blocked until that prerequisite lands.
describe.skip('TypedEventBus durable persistence contract', () => {
  it('does not dispatch durable typed-event listeners when persistence fails', async () => {
    const listener = vi.fn();
    const persistEvent = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const bus = new TypedEventBus({ persistEvent });
    bus.on('agent.created', listener);

    await bus.emit('agent.created', agentCreatedPayload());
    await flushMicrotasks();

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('dispatches typed-event listeners once, and only after durable persistence succeeds', async () => {
    const observedOrder: string[] = [];
    const persistEvent = vi.fn().mockImplementation(async () => {
      observedOrder.push('persist:start');
      await flushMicrotasks();
      observedOrder.push('persist:done');
    });
    const bus = new TypedEventBus({ persistEvent });
    bus.on('agent.created', () => observedOrder.push('listener'));

    await bus.emit('agent.created', agentCreatedPayload());
    await flushMicrotasks();

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(observedOrder).toEqual(['persist:start', 'persist:done', 'listener']);
  });

  it('keeps successful persistence successful when a post-persist listener fails', async () => {
    const errors: Array<{ source: string; event: string; error: string }> = [];
    const persistEvent = vi.fn().mockResolvedValue(undefined);
    const bus = new TypedEventBus({ persistEvent });
    bus.on('bus.error', (payload) => errors.push(payload));
    bus.on('agent.created', () => {
      throw new Error('listener failed');
    });

    await bus.emit('agent.created', agentCreatedPayload());
    await flushMicrotasks();

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([
      expect.objectContaining({ source: 'handler', event: 'agent.created', error: 'listener failed' }),
    ]);
  });

  it('grounds trigger chaining in persisted custom events', async () => {
    const onFire = vi.fn().mockResolvedValue(undefined);
    const bus = new TypedEventBus({
      persistEvent: vi.fn().mockRejectedValue(new Error('persist rejected')),
    });
    const triggerManager = new EventTriggerManager(bus, customTriggerDbMock(), onFire);
    await triggerManager.start();
    await triggerManager.register({
      agentId: 'agent-2',
      eventType: 'custom.ready',
      selector: { ok: true },
      taskTemplate: 'process {{value}}',
      enabled: true,
    });

    bus.emitCustom('custom.ready', 'agent-1', { ok: true, value: 'persisted-only' });
    await flushMicrotasks();

    expect(onFire).not.toHaveBeenCalled();
  });

  it.todo('keeps post-createTurn startup cleanup consistent when event persistence fails after Stage 2 lifecycle boundary lands');
});
