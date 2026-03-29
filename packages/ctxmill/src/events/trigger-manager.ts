import { randomUUID } from 'node:crypto';
import type { TypedEventBus, EventName } from './bus.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { EventTrigger } from './triggers.js';
import { interpolateTemplate } from './triggers.js';
import { matchesSelector } from './wait-condition.js';

/** Maximum trigger depth to prevent infinite trigger chains. */
export const MAX_TRIGGER_DEPTH = 5;

function selectorsEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  const aNorm = a && Object.keys(a).length > 0 ? a : null;
  const bNorm = b && Object.keys(b).length > 0 ? b : null;
  if (aNorm === null && bNorm === null) return true;
  if (aNorm === null || bNorm === null) return false;
  const aKeys = Object.keys(aNorm).sort();
  const bKeys = Object.keys(bNorm).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && JSON.stringify(aNorm[k]) === JSON.stringify(bNorm[bKeys[i]]));
}

/** Callback invoked when a trigger fires to start a background run. */
export type TriggerRunCallback = (agentId: string, task: string, triggerId: string, triggerDepth?: number) => Promise<void>;

/** All known event types the trigger manager subscribes to. */
const KNOWN_EVENT_TYPES: EventName[] = [
  'run.started',
  'run.text_chunk',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'run.completed',
  'run.resumed',
  'feedback.received',
  'agent.created',
  'agent.deleted',
  'client.connected',
  'client.disconnected',
  'learning.trace_captured',
  'learning.insight_extracted',
  'learning.knowledge_updated',
];

/**
 * EventTriggerManager stores event triggers and fires background runs
 * when matching events arrive on the bus.
 *
 * Triggers are persisted to the database and loaded on startup.
 * Each trigger maps an event type + optional selector to a target agent
 * and a task template.
 */
export class EventTriggerManager {
  private triggers = new Map<string, EventTrigger>();
  private eventBus: TypedEventBus;
  private db: DatabaseRepository;
  private onFire: TriggerRunCallback;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter handler types are wider than EventMap
  private handlers: Map<string, (...args: any[]) => void> = new Map();
  /** Tracks custom event types we're subscribed to (beyond KNOWN_EVENT_TYPES). */
  private subscribedCustomTypes = new Set<string>();
  private readonly maxDepth: number;

  constructor(
    eventBus: TypedEventBus,
    db: DatabaseRepository,
    onFire: TriggerRunCallback,
    maxDepth?: number,
  ) {
    this.eventBus = eventBus;
    this.db = db;
    this.onFire = onFire;
    this.maxDepth = maxDepth ?? MAX_TRIGGER_DEPTH;
  }

  /**
   * Load persisted triggers from the database and subscribe to the event bus.
   * Call this once during server startup.
   */
  async start(): Promise<void> {
    // Load from DB
    const rows = await this.db.getTriggers();
    for (const row of rows) {
      const trigger: EventTrigger = {
        id: row.id,
        agentId: row.agentId,
        eventType: row.eventType,
        selector: row.selector ?? undefined,
        taskTemplate: row.taskTemplate,
        enabled: row.enabled,
        createdAt: row.createdAt,
      };
      this.triggers.set(trigger.id, trigger);
    }

    // Subscribe to all known event types
    for (const eventType of KNOWN_EVENT_TYPES) {
      this.subscribeToEvent(eventType);
    }

    // Subscribe to custom event types used by existing triggers
    for (const trigger of this.triggers.values()) {
      if (!KNOWN_EVENT_TYPES.includes(trigger.eventType as EventName)) {
        this.ensureCustomSubscription(trigger.eventType);
      }
    }

    console.log(`[EventTriggerManager] started with ${this.triggers.size} triggers`);
  }

  /**
   * Register a new trigger. Persists to DB.
   */
  async register(
    input: Omit<EventTrigger, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  ): Promise<EventTrigger> {
    const existing = this.findBySignature(input.agentId, input.eventType, input.selector);
    if (existing) {
      return existing;
    }

    const trigger: EventTrigger = {
      id: input.id ?? randomUUID(),
      agentId: input.agentId,
      eventType: input.eventType,
      selector: input.selector,
      taskTemplate: input.taskTemplate,
      enabled: input.enabled ?? true,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };

    // Persist
    await this.db.saveTrigger({
      id: trigger.id,
      agentId: trigger.agentId,
      eventType: trigger.eventType,
      selector: trigger.selector ?? null,
      taskTemplate: trigger.taskTemplate,
      enabled: trigger.enabled,
      createdAt: trigger.createdAt,
    });

    this.triggers.set(trigger.id, trigger);

    // Subscribe to custom event type if needed
    if (!KNOWN_EVENT_TYPES.includes(trigger.eventType as EventName)) {
      this.ensureCustomSubscription(trigger.eventType);
    }

    return trigger;
  }

  /**
   * Remove a trigger by ID.
   */
  async unregister(triggerId: string): Promise<boolean> {
    const existed = this.triggers.has(triggerId);
    if (existed) {
      this.triggers.delete(triggerId);
      await this.db.deleteTrigger(triggerId);
    }
    return existed;
  }

  /**
   * Update a trigger (enable/disable, change template, etc.).
   */
  async update(
    triggerId: string,
    updates: Partial<Pick<EventTrigger, 'enabled' | 'taskTemplate' | 'selector' | 'eventType'>>,
  ): Promise<EventTrigger | undefined> {
    const existing = this.triggers.get(triggerId);
    if (!existing) return undefined;

    const updated: EventTrigger = { ...existing, ...updates };
    this.triggers.set(triggerId, updated);

    await this.db.saveTrigger({
      id: updated.id,
      agentId: updated.agentId,
      eventType: updated.eventType,
      selector: updated.selector ?? null,
      taskTemplate: updated.taskTemplate,
      enabled: updated.enabled,
      createdAt: updated.createdAt,
    });

    // Subscribe to new custom event type if changed
    if (updates.eventType && !KNOWN_EVENT_TYPES.includes(updates.eventType as EventName)) {
      this.ensureCustomSubscription(updates.eventType);
    }

    return updated;
  }

  /**
   * Get a single trigger by ID.
   */
  get(triggerId: string): EventTrigger | undefined {
    return this.triggers.get(triggerId);
  }

  private findBySignature(
    agentId: string,
    eventType: string,
    selector?: Record<string, unknown> | null,
  ): EventTrigger | undefined {
    for (const trigger of this.triggers.values()) {
      if (trigger.agentId !== agentId) continue;
      if (trigger.eventType !== eventType) continue;
      if (!selectorsEqual(trigger.selector, selector)) continue;
      return trigger;
    }
    return undefined;
  }

  /**
   * List triggers, optionally filtered by agentId.
   */
  list(agentId?: string): EventTrigger[] {
    const all = Array.from(this.triggers.values());
    if (agentId) {
      return all.filter((t) => t.agentId === agentId);
    }
    return all;
  }

  /**
   * Emit a custom event on the bus, which may trigger matching triggers.
   * The `_triggerDepth` field in the payload is propagated to prevent infinite chains.
   */
  emitCustomEvent(type: string, agentId: string | undefined, payload: Record<string, unknown>): void {
    // Ensure we're subscribed to this custom type
    this.ensureCustomSubscription(type);

    // Propagate _triggerDepth from the incoming payload if present
    const eventPayload: Record<string, unknown> = {
      type,
      agentId: agentId ?? '',
      payload,
      timestamp: Date.now(),
    };

    // Carry forward _triggerDepth so handleEvent can enforce the cascade limit
    if (typeof payload._triggerDepth === 'number') {
      eventPayload._triggerDepth = payload._triggerDepth;
    }

    this.eventBus.emit(type as never, eventPayload as never);

    this.handleEvent(type, eventPayload).catch((err) =>
      console.error(`[EventTriggerManager] error handling custom event ${type}:`, err),
    );
  }

  /**
   * Subscribe to a specific event type on the bus.
   */
  private subscribeToEvent(eventType: string): void {
    if (this.handlers.has(eventType)) return;

    const handler = (payload: unknown) => {
      this.handleEvent(eventType, payload).catch((err) =>
        console.error(`[EventTriggerManager] error handling ${eventType}:`, err),
      );
    };

    this.handlers.set(eventType, handler);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom event types aren't in EventMap
    this.eventBus.on(eventType as any, handler);
  }

  /**
   * Ensure a custom event type has a subscription.
   */
  private ensureCustomSubscription(eventType: string): void {
    if (this.subscribedCustomTypes.has(eventType)) return;
    this.subscribedCustomTypes.add(eventType);
    this.subscribeToEvent(eventType);
  }

  /**
   * Handle an incoming event: check all triggers for matches and fire runs.
   * Respects `_triggerDepth` in the payload to prevent infinite trigger chains.
   */
  private async handleEvent(eventType: string, payload: unknown): Promise<void> {
    const payloadObj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

    // --- Cascade protection: check trigger depth ---
    const currentDepth = typeof payloadObj._triggerDepth === 'number' ? payloadObj._triggerDepth : 0;
    if (currentDepth >= this.maxDepth) {
      console.warn(
        `[EventTriggerManager] skipping event "${eventType}" — trigger depth ${currentDepth} reached max (${this.maxDepth})`,
      );
      return;
    }

    const firedAgents = new Set<string>();

    for (const trigger of this.triggers.values()) {
      if (!trigger.enabled) continue;
      if (trigger.eventType !== eventType) continue;

      // Check selector match
      if (trigger.selector && Object.keys(trigger.selector).length > 0) {
        // For custom events, the payload fields may be nested under 'payload'
        const matchTarget = 'payload' in payloadObj && typeof payloadObj.payload === 'object'
          ? { ...payloadObj, ...(payloadObj.payload as Record<string, unknown>) }
          : payloadObj;

        if (!matchesSelector(matchTarget, trigger.selector)) continue;
      }

      if (firedAgents.has(trigger.agentId)) continue;

      // Interpolate the task template
      const flatPayload = 'payload' in payloadObj && typeof payloadObj.payload === 'object'
        ? { ...payloadObj, ...(payloadObj.payload as Record<string, unknown>) }
        : payloadObj;
      const task = interpolateTemplate(trigger.taskTemplate, flatPayload);

      // Fire the run — errors are isolated per trigger
      try {
        await this.onFire(trigger.agentId, task, trigger.id, currentDepth + 1);
        firedAgents.add(trigger.agentId);

        // Emit trigger.fired event (as a custom event to avoid circular typed emit)
        console.log(`[EventTriggerManager] trigger ${trigger.id} fired for agent ${trigger.agentId}`);
      } catch (err) {
        console.error(
          `[EventTriggerManager] failed to fire trigger ${trigger.id} for agent ${trigger.agentId}:`,
          err,
        );
      }
    }
  }

  /**
   * Clean up event bus subscriptions.
   */
  shutdown(): void {
    for (const [eventType, handler] of this.handlers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- custom event types aren't in EventMap
      this.eventBus.off(eventType as any, handler);
    }
    this.handlers.clear();
    this.subscribedCustomTypes.clear();
  }
}
