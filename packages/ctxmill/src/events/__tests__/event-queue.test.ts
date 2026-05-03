import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../bus.js';
import { EventQueueImpl } from '../event-queue.js';
import type { DatabaseRepository, ScheduledEventRow } from '../../database/repository.js';

function createQueueDb() {
  return {
    saveEvent: vi.fn().mockResolvedValue(42),
    getEventsSince: vi.fn(),
    createScheduledEvent: vi.fn(),
    getScheduledEventsDue: vi.fn().mockResolvedValue([]),
    markScheduledEventCompleted: vi.fn(),
    releaseScheduledEventClaim: vi.fn(),
  } as unknown as DatabaseRepository;
}

function createScheduledEvent(overrides: Partial<ScheduledEventRow> = {}): ScheduledEventRow {
  return {
    id: 'scheduled-1',
    agentId: 'agent-1',
    type: 'agent.created',
    payload: JSON.stringify({ name: 'Agent One' }),
    wakeAt: Date.now() - 1,
    status: 'in_progress',
    attempts: 1,
    claimedAt: 12345,
    claimExpiresAt: 12345 + 60_000,
    lastError: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function getPollScheduledEvents(queue: EventQueueImpl): () => Promise<void> {
  return Reflect.get(queue, 'pollScheduledEvents').bind(queue) as () => Promise<void>;
}

describe('EventQueueImpl durable dispatch', () => {
  it('dispatches enqueue events through the post-persist hook without a duplicate bus persistence write', async () => {
    const db = createQueueDb();
    const busPersistEvent = vi.fn().mockRejectedValue(new Error('bus persist should not be called'));
    const bus = new TypedEventBus({ persistEvent: busPersistEvent });
    const queue = new EventQueueImpl(bus, db);
    const listener = vi.fn();
    bus.on('agent.created', listener);

    await expect(queue.enqueue({
      type: 'agent.created',
      agentId: 'agent-1',
      payload: { agentId: 'agent-1', name: 'Agent One', timestamp: Date.now() },
    })).resolves.toBe('42');

    expect(db.saveEvent).toHaveBeenCalledTimes(1);
    expect(busPersistEvent).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);

    await queue.shutdown();
  });

  it('fires only claimed scheduled events, injects row ownership into live payloads, and completes the active claim', async () => {
    const scheduled = createScheduledEvent();
    const db = createQueueDb();
    vi.mocked(db.getScheduledEventsDue).mockResolvedValue([scheduled]);
    const bus = new TypedEventBus();
    const queue = new EventQueueImpl(bus, db);
    const listener = vi.fn();
    const allListener = vi.fn();
    bus.onAgent('agent.created', 'agent-1', listener);
    bus.on('agent.created', allListener);

    await getPollScheduledEvents(queue)();

    expect(db.getScheduledEventsDue).toHaveBeenCalledTimes(1);
    expect(db.saveEvent).toHaveBeenCalledWith(
      'agent.created',
      'agent-1',
      JSON.stringify({ name: 'Agent One', agentId: 'agent-1' }),
    );
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1',
      name: 'Agent One',
    }));
    expect(allListener).toHaveBeenCalledTimes(1);
    expect(db.markScheduledEventCompleted).toHaveBeenCalledWith('scheduled-1', 12345);
    expect(db.releaseScheduledEventClaim).not.toHaveBeenCalled();

    await queue.shutdown();
  });

  it('releases the exact scheduled event claim when event persistence fails', async () => {
    const scheduled = createScheduledEvent({ id: 'scheduled-failure', claimedAt: 98765 });
    const db = createQueueDb();
    vi.mocked(db.getScheduledEventsDue).mockResolvedValue([scheduled]);
    vi.mocked(db.saveEvent).mockRejectedValue(new Error('event store unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = new TypedEventBus();
    const queue = new EventQueueImpl(bus, db);

    try {
      await getPollScheduledEvents(queue)();
    } finally {
      errorSpy.mockRestore();
    }

    expect(db.markScheduledEventCompleted).not.toHaveBeenCalled();
    expect(db.releaseScheduledEventClaim).toHaveBeenCalledWith(
      'scheduled-failure',
      'event store unavailable',
      98765,
    );

    await queue.shutdown();
  });
});
