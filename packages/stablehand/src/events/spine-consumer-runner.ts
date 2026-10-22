import type { DatabaseRepository, EventFrameRow } from '../database/repository.js';
import type { CanonicalLog, FrameSubscriber } from '../orchestrator/canonical/canonical-log.js';
import type { PersistedFrame } from '../orchestrator/canonical/frames.js';

export interface SpineRawEvent {
  seq: number;
  sourceType: string;
  sourcePayload: string;
  payload: Record<string, unknown>;
  agentId: string;
  turnId: string | null;
  conversationId: string | null;
  createdAt: number;
}

export interface SpineConsumer {
  name: string;
  wants(sourceType: string): boolean;
  handle(event: SpineRawEvent): Promise<void>;
  /**
   * Durably record an event this consumer is giving up on after `maxAttempts`
   * failed catch-up deliveries (ADR-017 amendment, ctx-v6ef). Resolving lets
   * the cursor move past the event; throwing holds it and the give-up is
   * retried after backoff. Consumers without this hook keep retrying with
   * capped backoff and never skip an event.
   */
  deadLetter?(event: SpineRawEvent, error: unknown, attempts: number): Promise<void>;
}

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface SpineConsumerRunnerDeps {
  canonicalLog: Pick<CanonicalLog, 'subscribe'>;
  db: Pick<DatabaseRepository, 'getSourceEventsSince' | 'getSpineCursor' | 'advanceSpineCursor'>;
  consumers: SpineConsumer[];
  logger: Logger;
  rescanIntervalMs?: number;
  batchSize?: number;
  /** Catch-up deliveries of one event before a consumer's deadLetter hook runs. */
  maxAttempts?: number;
  /** Delay before the second delivery; doubles per attempt up to retryMaxDelayMs. */
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  now?: () => number;
}

const DEFAULT_RESCAN_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 500;
// 8 deliveries spaced 5 s, 10 s, 20 s, ... capped at 5 min: about ten minutes
// of retries before a consumer with a deadLetter hook gives up on an event.
export const DEFAULT_SPINE_MAX_ATTEMPTS = 8;
export const DEFAULT_SPINE_RETRY_BASE_DELAY_MS = 5_000;
export const DEFAULT_SPINE_RETRY_MAX_DELAY_MS = 300_000;

interface RetryState {
  seq: number;
  attempts: number;
  nextAttemptAt: number;
}

function parseSourcePayload(row: Pick<EventFrameRow, 'seq' | 'sourcePayload'>): Record<string, unknown> | null {
  if (!row.sourcePayload) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.sourcePayload) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return null;
  }
}

function rowToRawEvent(row: EventFrameRow): SpineRawEvent | null {
  if (!row.sourceType || !row.sourcePayload) {
    return null;
  }
  const payload = parseSourcePayload(row);
  if (!payload) {
    return null;
  }
  return {
    seq: row.seq,
    sourceType: row.sourceType,
    sourcePayload: row.sourcePayload,
    payload,
    agentId: row.agentId,
    turnId: row.turnId,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
  };
}

function frameToRawEvent(frame: PersistedFrame): SpineRawEvent | null {
  if (!frame.sourceType || !frame.sourcePayload) {
    return null;
  }
  const payload = parseSourcePayload({ seq: frame.seq, sourcePayload: frame.sourcePayload });
  if (!payload) {
    return null;
  }
  return {
    seq: frame.seq,
    sourceType: frame.sourceType,
    sourcePayload: frame.sourcePayload,
    payload,
    agentId: frame.agentId,
    turnId: frame.turnId ?? null,
    conversationId: frame.conversationId ?? null,
    createdAt: frame.createdAt,
  };
}

/**
 * Durable source-event consumer runner (ADR-017).
 *
 * Live canonical-log fan-out gives low latency but does not move cursors; the
 * ordered catch-up loop advances per-consumer cursors after handlers finish.
 * This avoids skipping lower seqs that might commit after a higher seq while
 * still making live delivery fast. Consumer effects must therefore be
 * idempotent by event seq.
 *
 * A failed catch-up delivery holds the cursor and is retried with exponential
 * backoff. After `maxAttempts` deliveries, a consumer that implements
 * `deadLetter` durably records the event and the cursor moves on, so one
 * poison event cannot block the events behind it (ctx-v6ef). Consumers settle
 * their own non-retryable failures inside `handle` without throwing.
 */
export class SpineConsumerRunner {
  private readonly consumers: SpineConsumer[];
  private readonly rescanIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly now: () => number;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private catchUpInProgress = new Set<string>();
  private readonly retryState = new Map<string, RetryState>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: SpineConsumerRunnerDeps) {
    this.consumers = deps.consumers;
    this.rescanIntervalMs = deps.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_SPINE_MAX_ATTEMPTS);
    this.retryBaseDelayMs = deps.retryBaseDelayMs ?? DEFAULT_SPINE_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = deps.retryMaxDelayMs ?? DEFAULT_SPINE_RETRY_MAX_DELAY_MS;
    this.now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const subscriber: FrameSubscriber = (frames) => this.handleLiveFrames(frames);
    this.unsubscribe = this.deps.canonicalLog.subscribe(subscriber);
    await this.catchUpAll();
    this.timer = setInterval(() => {
      this.catchUpAll().catch((err) => this.deps.logger.error('[SpineConsumerRunner] rescan failed:', err));
    }, this.rescanIntervalMs);
    this.timer.unref?.();
    this.deps.logger.info(
      '[SpineConsumerRunner] started with %d consumers (rescan every %dms)',
      this.consumers.length,
      this.rescanIntervalMs,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.catchUpInProgress.clear();
    for (const retryTimer of this.retryTimers.values()) {
      clearTimeout(retryTimer);
    }
    this.retryTimers.clear();
    this.retryState.clear();
  }

  async catchUpAll(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => this.catchUpConsumer(consumer)));
  }

  private handleLiveFrames(frames: PersistedFrame[]): void {
    for (const frame of frames) {
      const event = frameToRawEvent(frame);
      if (!event) continue;
      for (const consumer of this.consumers) {
        if (!consumer.wants(event.sourceType)) continue;
        consumer.handle(event).catch((err) => {
          this.deps.logger.error(
            `[SpineConsumerRunner] live consumer ${consumer.name} failed for seq ${event.seq}:`,
            err,
          );
        });
      }
    }
  }

  private async catchUpConsumer(consumer: SpineConsumer): Promise<void> {
    if (this.catchUpInProgress.has(consumer.name)) {
      return;
    }
    this.catchUpInProgress.add(consumer.name);
    try {
      let cursor = await this.deps.db.getSpineCursor(consumer.name);
      let holding = false;
      while (this.running && !holding) {
        const rows = await this.deps.db.getSourceEventsSince(cursor, this.batchSize);
        if (rows.length === 0) {
          break;
        }
        for (const row of rows) {
          const event = rowToRawEvent(row);
          if (event && consumer.wants(event.sourceType)) {
            if (!await this.deliver(consumer, event)) {
              // Hold the cursor behind this event until a retry settles it.
              holding = true;
              break;
            }
          } else if (!event) {
            this.deps.logger.warn(
              `[SpineConsumerRunner] skipping malformed source event row seq ${row.seq} for ${consumer.name}`,
            );
          }
          await this.deps.db.advanceSpineCursor(consumer.name, row.seq);
          cursor = row.seq;
        }
        if (rows.length < this.batchSize) {
          break;
        }
      }
    } catch (err) {
      this.deps.logger.error(`[SpineConsumerRunner] catch-up failed for ${consumer.name}:`, err);
    } finally {
      this.catchUpInProgress.delete(consumer.name);
    }
  }

  /**
   * One ordered catch-up delivery. Resolves true once the event is settled
   * (handled, or dead-lettered after the attempt budget) and the cursor may
   * advance; false while the cursor must hold behind it.
   */
  private async deliver(consumer: SpineConsumer, event: SpineRawEvent): Promise<boolean> {
    const state = this.retryState.get(consumer.name);
    const pending = state?.seq === event.seq ? state : undefined;
    if (pending && this.now() < pending.nextAttemptAt) {
      this.scheduleRetry(consumer, pending.nextAttemptAt - this.now());
      return false;
    }

    try {
      await consumer.handle(event);
    } catch (err) {
      const attempts = (pending?.attempts ?? 0) + 1;
      if (consumer.deadLetter && attempts >= this.maxAttempts) {
        return this.giveUp(consumer, event, err, attempts);
      }
      const delayMs = this.holdForRetry(consumer, event.seq, attempts);
      this.deps.logger.error(
        `[SpineConsumerRunner] ${consumer.name} failed seq ${event.seq} (${event.sourceType}), `
        + `attempt ${attempts}${consumer.deadLetter ? ` of ${this.maxAttempts}` : ''}; retrying in ${delayMs}ms:`,
        err,
      );
      return false;
    }

    this.retryState.delete(consumer.name);
    return true;
  }

  private async giveUp(
    consumer: SpineConsumer,
    event: SpineRawEvent,
    err: unknown,
    attempts: number,
  ): Promise<boolean> {
    try {
      await consumer.deadLetter?.(event, err, attempts);
    } catch (deadLetterErr) {
      const delayMs = this.holdForRetry(consumer, event.seq, attempts);
      this.deps.logger.error(
        `[SpineConsumerRunner] ${consumer.name} could not dead-letter seq ${event.seq} (${event.sourceType}); `
        + `holding the cursor and retrying in ${delayMs}ms:`,
        deadLetterErr,
      );
      return false;
    }
    this.retryState.delete(consumer.name);
    this.deps.logger.warn(
      `[SpineConsumerRunner] ${consumer.name} gave up on seq ${event.seq} (${event.sourceType}) after `
      + `${attempts} attempts; dead-lettered it and moved on:`,
      err,
    );
    return true;
  }

  private holdForRetry(consumer: SpineConsumer, seq: number, attempts: number): number {
    const delayMs = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** (attempts - 1));
    this.retryState.set(consumer.name, { seq, attempts, nextAttemptAt: this.now() + delayMs });
    this.scheduleRetry(consumer, delayMs);
    return delayMs;
  }

  private scheduleRetry(consumer: SpineConsumer, delayMs: number): void {
    if (!this.running || this.retryTimers.has(consumer.name)) {
      return;
    }
    const retryTimer = setTimeout(() => {
      this.retryTimers.delete(consumer.name);
      this.catchUpConsumer(consumer).catch((err) => this.deps.logger.error(
        `[SpineConsumerRunner] retry catch-up failed for ${consumer.name}:`,
        err,
      ));
    }, Math.max(0, delayMs));
    retryTimer.unref?.();
    this.retryTimers.set(consumer.name, retryTimer);
  }
}
