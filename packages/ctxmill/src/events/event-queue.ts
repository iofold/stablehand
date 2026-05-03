import { randomUUID } from 'node:crypto';
import type { TypedEventBus, EventMap, EventName } from './bus.js';
import { waitForEvent } from './wait-for-event.js';
import type { DatabaseRepository } from '../database/repository.js';

/**
 * EventQueue interface — a higher-level abstraction over the event bus
 * that adds persistence, scheduled events, and cursor-based replay.
 */
export interface EventQueue {
  enqueue(event: { type: string; payload: unknown; agentId: string }): Promise<string>;
  subscribe<K extends EventName>(type: K, handler: (payload: EventMap[K]) => void | Promise<void>): () => void;
  waitFor<K extends EventName>(type: K, predicate: (payload: EventMap[K]) => boolean, timeoutMs: number): Promise<EventMap[K]>;
  scheduleAt(event: { type: string; payload: unknown; agentId: string }, executeAt: Date): Promise<string>;
  getEventsSince(agentId: string, afterCursor: string | number, limit: number): Promise<Array<{ cursor: string | number; type: string; payload: unknown; createdAt: number }>>;
  shutdown(): Promise<void>;
}

function normalizeScheduledPayload(payload: unknown, agentId: string): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return payload;
  }

  return {
    ...payload,
    agentId,
  };
}

/**
 * Database-backed EventQueue implementation.
 *
 * - enqueue(): persists to event_store via db.saveEvent(), emits on bus, returns seq as string
 * - subscribe(): delegates to bus.on(), returns unsubscribe function
 * - waitFor(): delegates to waitForEvent() utility
 * - scheduleAt(): inserts into scheduled_events table, returns id
 * - getEventsSince(): delegates to db.getEventsSince(), maps seq to cursor
 * - Internal: 30s polling loop for scheduled_events (fires due events onto bus)
 * - shutdown(): clears polling interval
 */
export class EventQueueImpl implements EventQueue {
  private bus: TypedEventBus;
  private db: DatabaseRepository;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(bus: TypedEventBus, db: DatabaseRepository) {
    this.bus = bus;
    this.db = db;
    this.startPolling();
  }

  async enqueue(event: { type: string; payload: unknown; agentId: string }): Promise<string> {
    const seq = await this.db.saveEvent(
      event.type,
      event.agentId,
      JSON.stringify(event.payload),
    );
    // Dispatch only after explicit repository persistence succeeds; avoid a duplicate
    // event_store write when the bus itself is persistence-configured.
    this.bus.emitPersisted(event.type as EventName, event.payload as EventMap[EventName]);
    return String(seq);
  }

  subscribe<K extends EventName>(type: K, handler: (payload: EventMap[K]) => void | Promise<void>): () => void {
    this.bus.on(type, handler);
    return () => this.bus.off(type, handler);
  }

  waitFor<K extends EventName>(type: K, predicate: (payload: EventMap[K]) => boolean, timeoutMs: number): Promise<EventMap[K]> {
    return waitForEvent(this.bus, type, predicate, timeoutMs);
  }

  async scheduleAt(event: { type: string; payload: unknown; agentId: string }, executeAt: Date): Promise<string> {
    const id = randomUUID();
    await this.db.createScheduledEvent({
      id,
      agentId: event.agentId,
      type: event.type,
      payload: JSON.stringify(event.payload),
      wakeAt: executeAt.getTime(),
    });
    return id;
  }

  async getEventsSince(
    agentId: string,
    afterCursor: string | number,
    limit: number,
  ): Promise<Array<{ cursor: string | number; type: string; payload: unknown; createdAt: number }>> {
    const afterSeq = typeof afterCursor === 'string' ? parseInt(afterCursor, 10) : afterCursor;
    const rows = await this.db.getEventsSince(agentId, afterSeq, limit);
    return rows.map((row) => ({
      cursor: row.seq,
      type: row.type,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      createdAt: row.createdAt,
    }));
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.pollingInterval !== null) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private startPolling(): void {
    this.pollingInterval = setInterval(() => {
      if (this.shuttingDown) return;
      this.pollScheduledEvents().catch((err) =>
        console.error('[EventQueueImpl] polling error:', err),
      );
    }, 30_000);
  }

  private async pollScheduledEvents(): Promise<void> {
    const dueEvents = await this.db.getScheduledEventsDue(Date.now());
    for (const event of dueEvents) {
      try {
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        const dispatchPayload = normalizeScheduledPayload(payload, event.agentId);
        await this.db.saveEvent(event.type, event.agentId, JSON.stringify(dispatchPayload));
        this.bus.emitPersisted(event.type as EventName, dispatchPayload as EventMap[EventName]);
        await this.db.markScheduledEventCompleted(event.id, event.claimedAt);
      } catch (err) {
        console.error(`[EventQueueImpl] error firing scheduled event ${event.id}:`, err);
        await this.db.releaseScheduledEventClaim(
          event.id,
          err instanceof Error ? err.message : String(err),
          event.claimedAt,
        );
      }
    }
  }
}
