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
}

const DEFAULT_RESCAN_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 500;

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
 */
export class SpineConsumerRunner {
  private readonly consumers: SpineConsumer[];
  private readonly rescanIntervalMs: number;
  private readonly batchSize: number;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private catchUpInProgress = new Set<string>();

  constructor(private readonly deps: SpineConsumerRunnerDeps) {
    this.consumers = deps.consumers;
    this.rescanIntervalMs = deps.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
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
      while (this.running) {
        const rows = await this.deps.db.getSourceEventsSince(cursor, this.batchSize);
        if (rows.length === 0) {
          break;
        }
        for (const row of rows) {
          const event = rowToRawEvent(row);
          if (event && consumer.wants(event.sourceType)) {
            await consumer.handle(event);
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
}
