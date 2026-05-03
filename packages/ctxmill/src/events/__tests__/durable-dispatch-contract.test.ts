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

describe('TypedEventBus durable persistence contract', () => {
  it('does not dispatch durable typed-event listeners when persistence fails', async () => {
    const listener = vi.fn();
    const persistEvent = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const bus = new TypedEventBus({ persistEvent });
    bus.on('agent.created', listener);

    await expect(bus.emitAsync('agent.created', agentCreatedPayload())).rejects.toThrow('db unavailable');
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
    bus.on('agent.created', () => {
      observedOrder.push('listener');
    });

    await bus.emitAsync('agent.created', agentCreatedPayload());
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

    await bus.emitAsync('agent.created', agentCreatedPayload());
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

    await expect(
      bus.emitCustomAsync('custom.ready', 'agent-1', { ok: true, value: 'persisted-only' }),
    ).rejects.toThrow('persist rejected');
    await flushMicrotasks();

    expect(onFire).not.toHaveBeenCalled();
  });

  // Stage 2 lifecycle/retry-policy code (e.g. session-turn-orchestrator turn.started/turn.completed)
  // uses the fire-and-forget bus.emit() path. Verify that path also defers listener dispatch until
  // persistence resolves, and skips dispatch when persistence rejects, so the lifecycle emit sites
  // cannot bypass the durable persistence contract.
  it('fire-and-forget emit() defers dispatch until persistence settles and skips on persist failure', async () => {
    const observedOrder: string[] = [];
    let resolvePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      resolvePersist = resolve;
    });
    const persistEvent = vi.fn().mockImplementation(async () => {
      observedOrder.push('persist:start');
      await persistGate;
      observedOrder.push('persist:done');
    });
    const bus = new TypedEventBus({ persistEvent });
    bus.on('agent.created', () => {
      observedOrder.push('listener');
    });

    bus.emit('agent.created', agentCreatedPayload());

    // Listener must NOT have fired before persistence settles.
    await flushMicrotasks();
    expect(observedOrder).toEqual(['persist:start']);

    resolvePersist();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(observedOrder).toEqual(['persist:start', 'persist:done', 'listener']);

    // Persistence failure path: listener stays silent and the bus surfaces a bus.error.
    const failingListener = vi.fn();
    const errors: Array<{ source: string; event: string; error: string }> = [];
    const failingBus = new TypedEventBus({
      persistEvent: vi.fn().mockRejectedValue(new Error('lifecycle persist failed')),
    });
    failingBus.on('bus.error', (payload) => errors.push(payload));
    failingBus.on('agent.created', failingListener);

    failingBus.emit('agent.created', agentCreatedPayload({ agentId: 'agent-2' }));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(failingListener).not.toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({ source: 'persist', event: 'agent.created', error: 'lifecycle persist failed' }),
    ]);
  });
});
