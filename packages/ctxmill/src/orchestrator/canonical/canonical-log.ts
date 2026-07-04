import type { DatabaseRepository } from '../../database/repository.js';
import { CanonicalProjector } from './projector.js';
import type { CanonicalFrame, PersistedFrame } from './frames.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

interface CanonicalLogDeps {
  db: Pick<DatabaseRepository, 'saveEventBatch' | 'getFramesSince' | 'getTurnFrames'>;
  logger: Logger;
}

export type FrameSubscriber = (frames: PersistedFrame[]) => void;

function parseBody(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { raw: payload };
  }
}

/**
 * The durable event spine (ADR-015): ingest projects internal bus events into
 * canonical frames, batch-persists them (one round trip, each frame gets its
 * own global seq), and only then fans out to in-process subscribers — so
 * downstream consumers (SSE, trigger chaining per ADR-006) never observe a
 * frame that is not durably persisted, and reconnect replay from seq is exact.
 */
export class CanonicalLog {
  private readonly projector = new CanonicalProjector();
  private readonly subscribers = new Set<FrameSubscriber>();

  constructor(private readonly deps: CanonicalLogDeps) {}

  /** Project + persist + fan-out. Resolves after the batch insert commits (ADR-006). */
  async ingest(eventName: string, payload: Record<string, unknown>): Promise<PersistedFrame[]> {
    const frames = this.projector.project(eventName, payload);
    if (frames.length === 0) {
      return [];
    }
    const persisted = await this.persist(frames);
    this.fanOut(persisted);
    return persisted;
  }

  subscribe(subscriber: FrameSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Durable replay of an agent's frames after a seq (run channel by default includes all). */
  async replaySince(
    agentId: string,
    afterSeq: number,
    options: { channels?: string[]; limit?: number } = {},
  ): Promise<PersistedFrame[]> {
    const rows = await this.deps.db.getFramesSince(agentId, afterSeq, options);
    return rows.map((row) => this.rowToFrame(row));
  }

  /** Replay the tail of a specific turn (reconnect snapshots for in-flight turns). */
  async replayTurnTail(turnId: string, afterSeq = 0): Promise<PersistedFrame[]> {
    const rows = await this.deps.db.getTurnFrames(turnId, afterSeq);
    return rows.map((row) => this.rowToFrame(row));
  }

  private async persist(frames: CanonicalFrame[]): Promise<PersistedFrame[]> {
    const now = Date.now();
    const seqs = await this.deps.db.saveEventBatch(frames.map((frame) => ({
      type: frame.type,
      agentId: frame.agentId,
      payload: JSON.stringify(frame.body),
      turnId: frame.turnId ?? null,
      conversationId: frame.conversationId ?? null,
      channel: frame.channel,
    })));
    return frames.map((frame, index) => ({
      ...frame,
      seq: seqs[index]!,
      createdAt: now,
    }));
  }

  private fanOut(frames: PersistedFrame[]): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(frames);
      } catch (err) {
        this.deps.logger.error('[CanonicalLog] subscriber failed:', err);
      }
    }
  }

  private rowToFrame(row: {
    seq: number;
    type: string;
    agentId: string;
    payload: string;
    createdAt: number;
    turnId: string | null;
    conversationId: string | null;
    channel: string;
  }): PersistedFrame {
    return {
      seq: row.seq,
      createdAt: row.createdAt,
      type: row.type,
      agentId: row.agentId,
      turnId: row.turnId,
      conversationId: row.conversationId,
      channel: (row.channel === 'run' || row.channel === 'custom' ? row.channel : 'system'),
      body: parseBody(row.payload),
    };
  }
}
