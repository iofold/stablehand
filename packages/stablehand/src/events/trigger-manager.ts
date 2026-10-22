import { randomUUID } from 'node:crypto';
import {
  ConversationIdSchema,
  CustomEventEmitInputSchema,
  TurnIdSchema,
} from '@stablehand/contracts';
import type { TypedEventBus } from './bus.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { TriggerSelect } from '../database/types.js';
import { isUniqueConstraintViolation } from '../database/errors.js';
import type { EventTrigger } from './triggers.js';
import { interpolateTemplate } from './triggers.js';
import { matchesSelector } from './wait-condition.js';
import type { SpineConsumer, SpineRawEvent } from './spine-consumer-runner.js';
import {
  classifyTriggerFireError,
  RetryableTriggerFireError,
  type TriggerFireFailure,
} from './trigger-errors.js';

/** Maximum trigger depth to prevent infinite trigger chains. */
export const MAX_TRIGGER_DEPTH = 5;

export interface CustomEventProvenance {
  keyId: string;
}

export class TriggerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriggerConflictError';
  }
}

function normalizeSelector(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSelector(entry));
  }
  if (typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 0) return null;

  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    normalized[key] = normalizeSelector(record[key]);
  }
  return normalized;
}

function selectorsEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  return JSON.stringify(normalizeSelector(a)) === JSON.stringify(normalizeSelector(b));
}

function hydrateTrigger(row: TriggerSelect | undefined): EventTrigger | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    agentId: row.agentId,
    eventType: row.eventType,
    selector: row.selector ?? undefined,
    taskTemplate: row.taskTemplate,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

/** Callback invoked when a trigger fires to start a background run. */
export type TriggerRunCallback = (
  agentId: string,
  task: string,
  triggerId: string,
  triggerDepth?: number,
  eventSeq?: number,
) => Promise<void>;

export function createTriggerSpineConsumer(manager: EventTriggerManager): SpineConsumer {
  return {
    name: 'event-triggers',
    wants: (sourceType) => manager.hasEnabledTriggerForEvent(sourceType),
    handle: (event) => manager.handleRawEvent(event),
    deadLetter: (event, error, attempts) => manager.deadLetterRawEvent(event, error, attempts),
  };
}

/** Custom events nest the caller's fields under `payload`; selectors and templates see both levels. */
function flattenEventPayload(payloadObj: Record<string, unknown>): Record<string, unknown> {
  return 'payload' in payloadObj && typeof payloadObj.payload === 'object' && payloadObj.payload !== null
    ? { ...payloadObj, ...(payloadObj.payload as Record<string, unknown>) }
    : payloadObj;
}

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
  private readonly maxDepth: number;
  private readonly retiredAgentIds = new Set<string>();

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
   * Load persisted triggers from the database.
   * Call this once during server startup.
   */
  async start(): Promise<void> {
    // Load from DB
    const rows = await this.db.getTriggers();
    for (const row of rows) {
      const trigger = hydrateTrigger(row);
      if (!trigger) continue;
      this.triggers.set(trigger.id, trigger);
    }

    console.log(`[EventTriggerManager] started with ${this.triggers.size} triggers`);
  }

  /**
   * Register a new trigger. Persists to DB.
   */
  async register(
    input: Omit<EventTrigger, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
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
      createdAt: input.createdAt ?? Date.now(),
    };

    let savedTrigger: EventTrigger;
    try {
      const saved = await this.db.saveTrigger({
        id: trigger.id,
        agentId: trigger.agentId,
        eventType: trigger.eventType,
        selector: trigger.selector ?? null,
        taskTemplate: trigger.taskTemplate,
        enabled: trigger.enabled,
        createdAt: trigger.createdAt,
      });
      savedTrigger = hydrateTrigger(saved) ?? trigger;
    } catch (err) {
      if (!isUniqueConstraintViolation(err)) {
        throw err;
      }
      const saved = await this.db.getTriggerBySignature(input.agentId, input.eventType, input.selector);
      const duplicate = hydrateTrigger(saved);
      if (!duplicate) {
        throw new TriggerConflictError(
          `Trigger already exists for ${input.agentId}/${input.eventType} with the same selector`,
        );
      }
      savedTrigger = duplicate;
    }

    if (!this.retiredAgentIds.has(savedTrigger.agentId)) {
      this.triggers.set(savedTrigger.id, savedTrigger);
    }

    return savedTrigger;
  }

  /**
   * Remove a trigger by ID.
   */
  async unregister(triggerId: string): Promise<boolean> {
    const existed = this.triggers.has(triggerId);
    if (existed) {
      await this.db.deleteTrigger(triggerId);
      this.triggers.delete(triggerId);
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
    const duplicate = this.findBySignature(updated.agentId, updated.eventType, updated.selector);
    if (duplicate && duplicate.id !== triggerId) {
      throw new TriggerConflictError(
        `Trigger already exists for ${updated.agentId}/${updated.eventType} with the same selector`,
      );
    }

    let savedTrigger: EventTrigger;
    try {
      const saved = await this.db.saveTrigger({
        id: updated.id,
        agentId: updated.agentId,
        eventType: updated.eventType,
        selector: updated.selector ?? null,
        taskTemplate: updated.taskTemplate,
        enabled: updated.enabled,
        createdAt: updated.createdAt,
      });
      savedTrigger = hydrateTrigger(saved) ?? updated;
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new TriggerConflictError(
          `Trigger already exists for ${updated.agentId}/${updated.eventType} with the same selector`,
        );
      }
      throw err;
    }

    if (!this.retiredAgentIds.has(savedTrigger.agentId)) {
      this.triggers.set(triggerId, savedTrigger);
    }

    return savedTrigger;
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
   * Fail closed when agent deletion begins: remove its loaded definitions,
   * and fence delayed spine handlers before they enter the run callback.
   * PostgreSQL owns durable trigger deletion via cascade. Turns that already
   * entered the callback remain owned by the normal session teardown path.
   */
  async stopForAgent(agentId: string): Promise<void> {
    this.retiredAgentIds.add(agentId);
    for (const [triggerId, trigger] of [...this.triggers]) {
      if (trigger.agentId === agentId) this.triggers.delete(triggerId);
    }
  }

  /**
   * Emit a custom event on the bus, which may trigger matching triggers.
   * The `_triggerDepth` field in the payload is propagated to prevent infinite chains.
   */
  emitCustomEvent(type: string, agentId: string | undefined, payload: Record<string, unknown>): void {
    this.emitCustomEventAsync(type, agentId, payload).catch((err: unknown) => {
      console.error(`[EventTriggerManager] failed to emit custom event "${type}":`, err);
    });
  }

  /**
   * Awaitable custom event emit for HTTP/RPC ACK boundaries that must not
   * report success before durable persistence accepts the event.
   */
  async emitCustomEventAsync(
    type: string,
    agentId: string | undefined,
    payload: Record<string, unknown>,
    provenance?: CustomEventProvenance,
  ): Promise<void> {
    const parsed = CustomEventEmitInputSchema.parse({
      type,
      ...(agentId === undefined ? {} : { agentId }),
      payload,
    });
    const turnId = TurnIdSchema.safeParse(parsed.payload.turnId);
    const conversationId = ConversationIdSchema.safeParse(parsed.payload.conversationId);
    // Propagate _triggerDepth from the incoming payload if present
    const eventPayload: Record<string, unknown> = {
      type: parsed.type,
      agentId: parsed.agentId ?? '',
      payload: parsed.payload,
      ...(turnId.success ? { turnId: turnId.data } : {}),
      ...(conversationId.success ? { conversationId: conversationId.data } : {}),
      ...(provenance ? { keyId: provenance.keyId } : {}),
      timestamp: Date.now(),
    };

    // Carry forward _triggerDepth so handleEvent can enforce the cascade limit
    if (typeof parsed.payload._triggerDepth === 'number') {
      eventPayload._triggerDepth = parsed.payload._triggerDepth;
    }

    // Emit to the bus. CanonicalLog persists the source event; SpineConsumerRunner
    // routes the durable source row back to handleRawEvent().
    await this.eventBus.emitCustomAsync(parsed.type, parsed.agentId ?? '', eventPayload);
    if (!this.hasDurablePersistence()) {
      // Non-durable tests and embedded in-memory harnesses do not construct a
      // CanonicalLog/SpineConsumerRunner. Keep those harnesses functional while
      // production buses with persistEvent remain spine-only.
      await this.handleEvent(parsed.type, eventPayload);
    }
  }

  hasEnabledTriggerForEvent(eventType: string): boolean {
    for (const trigger of this.triggers.values()) {
      if (trigger.enabled && trigger.eventType === eventType) {
        return true;
      }
    }
    return false;
  }

  async handleRawEvent(event: SpineRawEvent): Promise<void> {
    await this.handleEvent(event.sourceType, event.payload, event.seq);
  }

  private hasDurablePersistence(): boolean {
    return typeof (this.eventBus as unknown as { persistEvent?: unknown }).persistEvent === 'function';
  }

  /**
   * Handle an incoming event: check all triggers for matches and fire runs.
   * Respects `_triggerDepth` in the payload to prevent infinite trigger chains.
   */
  private async handleEvent(eventType: string, payload: unknown, eventSeq?: number): Promise<void> {
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
    const unsettled: Array<{ trigger: EventTrigger; err: unknown; failure: TriggerFireFailure }> = [];
    const flatPayload = flattenEventPayload(payloadObj);

    for (const trigger of this.matchingTriggers(eventType, flatPayload)) {
      if (firedAgents.has(trigger.agentId)) continue;
      if (eventSeq !== undefined && await this.db.hasTriggerFiring(trigger.id, eventSeq)) {
        firedAgents.add(trigger.agentId);
        continue;
      }
      if (this.retiredAgentIds.has(trigger.agentId)) continue;

      const task = interpolateTemplate(trigger.taskTemplate, flatPayload);

      // Fire the run — errors are isolated per trigger within this event.
      try {
        await this.fireTrigger(trigger, task, currentDepth, eventSeq);
        firedAgents.add(trigger.agentId);
        console.log(`[EventTriggerManager] trigger ${trigger.id} fired for agent ${trigger.agentId}`);
      } catch (err) {
        const failure = classifyTriggerFireError(err);
        if (eventSeq !== undefined && !failure.retryable) {
          // ctx-v6ef: retrying cannot change the outcome (e.g. the target is
          // interactive-only), so settle the firing as a dead letter now and
          // let the cursor move past the event.
          await this.deadLetterFiring(trigger, eventType, eventSeq, failure, 1, currentDepth);
          continue;
        }
        console.error(
          `[EventTriggerManager] failed to fire trigger ${trigger.id} for agent ${trigger.agentId}:`,
          err,
        );
        unsettled.push({ trigger, err, failure });
      }
    }

    const [firstUnsettled] = unsettled;
    if (!firstUnsettled) {
      return;
    }
    // ctx-mcef: swallowing a retryable failure let the cursor advance and lost
    // the dispatch forever. Rethrowing holds the cursor; the spine runner
    // retries with backoff and, once its attempt budget is spent, calls
    // deadLetterRawEvent (ctx-v6ef). The deterministic trigger turn id plus
    // the firing-row unique index make each retry effectively-once.
    if (eventSeq === undefined) {
      throw firstUnsettled.err;
    }
    throw new RetryableTriggerFireError(
      eventType,
      eventSeq,
      unsettled.map(({ trigger, failure }) => ({ triggerId: trigger.id, agentId: trigger.agentId, failure })),
      { cause: firstUnsettled.err },
    );
  }

  /**
   * Spine runner give-up hook (ctx-v6ef): after the retry budget for a source
   * event is spent, dead-letter every matching trigger that has not settled
   * for it yet, so the cursor can move past the event.
   */
  async deadLetterRawEvent(event: SpineRawEvent, error: unknown, attempts: number): Promise<void> {
    const payloadObj = event.payload;
    const currentDepth = typeof payloadObj._triggerDepth === 'number' ? payloadObj._triggerDepth : 0;
    if (currentDepth >= this.maxDepth) {
      return;
    }
    const reasons = new Map<string, TriggerFireFailure>();
    if (error instanceof RetryableTriggerFireError) {
      for (const { triggerId, failure } of error.failures) {
        reasons.set(triggerId, failure);
      }
    }
    const fallback = classifyTriggerFireError(error);
    const firedAgents = new Set<string>();
    for (const trigger of this.matchingTriggers(event.sourceType, flattenEventPayload(payloadObj))) {
      if (firedAgents.has(trigger.agentId)) continue;
      if (await this.db.hasTriggerFiring(trigger.id, event.seq)) {
        firedAgents.add(trigger.agentId);
        continue;
      }
      const failure = reasons.get(trigger.id) ?? fallback;
      await this.deadLetterFiring(
        trigger,
        event.sourceType,
        event.seq,
        { ...failure, message: `Gave up after ${attempts} attempts: ${failure.message}` },
        attempts,
        currentDepth,
      );
    }
  }

  /** Enabled, live triggers whose event type and selector match the (flattened) payload. */
  private *matchingTriggers(eventType: string, flatPayload: Record<string, unknown>): Generator<EventTrigger> {
    for (const trigger of this.triggers.values()) {
      if (!trigger.enabled) continue;
      if (this.retiredAgentIds.has(trigger.agentId)) continue;
      if (trigger.eventType !== eventType) continue;
      if (
        trigger.selector
        && Object.keys(trigger.selector).length > 0
        && !matchesSelector(flatPayload, trigger.selector)
      ) {
        continue;
      }
      yield trigger;
    }
  }

  /**
   * Durably record a failed firing, then publish `trigger.failed`. The row is
   * what settles the firing; the event is a notice, so a publish failure is
   * logged rather than thrown.
   */
  private async deadLetterFiring(
    trigger: EventTrigger,
    eventType: string,
    eventSeq: number,
    failure: TriggerFireFailure,
    attempts: number,
    currentDepth: number,
  ): Promise<void> {
    const row = await this.db.recordTriggerFiringFailure({
      triggerId: trigger.id,
      eventSeq,
      eventType,
      errorCode: failure.code,
      error: failure.message,
      attempts,
    });
    if (!row) {
      // Already settled (a concurrent live/catch-up delivery won) or the
      // trigger was deleted meanwhile: nothing new to report.
      return;
    }
    console.warn(
      `[EventTriggerManager] trigger ${trigger.id} for agent ${trigger.agentId} failed on ${eventType} `
      + `seq ${eventSeq} after ${attempts} attempt(s) [${failure.code}]: ${failure.message}`,
    );
    try {
      await this.eventBus.emitAsync('trigger.failed', {
        triggerId: trigger.id,
        agentId: trigger.agentId,
        eventType,
        eventSeq,
        errorCode: failure.code,
        error: failure.message,
        attempts,
        // A trigger on trigger.failed is a cascade like any other.
        _triggerDepth: currentDepth + 1,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error(
        `[EventTriggerManager] recorded failed firing for trigger ${trigger.id} seq ${eventSeq} `
        + 'but could not publish trigger.failed:',
        err,
      );
    }
  }

  private async fireTrigger(
    trigger: EventTrigger,
    task: string,
    currentDepth: number,
    eventSeq: number | undefined,
  ): Promise<void> {
    if (this.retiredAgentIds.has(trigger.agentId)) return;
    await this.onFire(
      trigger.agentId,
      task,
      trigger.id,
      currentDepth + 1,
      eventSeq,
    );
    if (eventSeq !== undefined) {
      await this.db.recordTriggerFiring(trigger.id, eventSeq);
    }
  }

  /**
   * Clean up trigger manager resources.
   */
  shutdown(): void {
    // Trigger delivery is owned by SpineConsumerRunner; no direct bus listeners
    // are registered here.
  }
}
