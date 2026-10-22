import type { DatabaseRepository } from '../../database/repository.js';
import { CanonicalStreamEventSchema } from '@stablehand/contracts';
import { CanonicalProjector } from './projector.js';
import type { CanonicalFrame, PersistedFrame } from './frames.js';
import type { EventPersistenceContext } from '../../events/bus.js';
import {
  performanceInstrumentation,
  type PerformanceRecorder,
} from '../../observability/performance.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

interface CanonicalLogDeps {
  db: Pick<
    DatabaseRepository,
    | 'saveEventBatch'
    | 'saveFencedEventBatch'
    | 'saveRecoveryEventBatch'
    | 'saveMessageEventBatch'
    | 'saveTerminalEventBatch'
    | 'getFramesSince'
    | 'getTurnFrames'
  >;
  logger: Logger;
  performance?: Pick<PerformanceRecorder, 'measure'>;
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
  // Single-lane ingest queue: persist + fan-out run strictly in call order.
  // The bus's fire-and-forget emit starts ingest for each event without
  // awaiting, so without this every ingest's async DB insert would race for
  // its seq — reordering streamed text deltas and tool frames on the wire
  // (and interleaving the projector's per-turn text state). Chaining onto a
  // tail promise makes emission order == seq order == fan-out order.
  private ingestTail: Promise<unknown> = Promise.resolve();
  // Depth of the ingest lane: chained-but-not-yet-settled ingests. The lane is
  // otherwise an opaque promise chain with nothing measurable; this gauge lets
  // the external emit ingress (ctx-bh1u) shed load with a typed 429 before the
  // lane grows without bound. Internal producers never consult it — they must
  // never be dropped — so the cap lives at the route, not in ingest().
  private pendingIngests = 0;

  /** Number of ingests chained but not yet settled (ctx-bh1u backpressure gauge). */
  get depth(): number {
    return this.pendingIngests;
  }

  constructor(private readonly deps: CanonicalLogDeps) {}

  /** Project + persist + fan-out. Resolves after the batch insert commits (ADR-006). */
  ingest(
    eventName: string,
    payload: Record<string, unknown>,
    context?: EventPersistenceContext,
  ): Promise<PersistedFrame[]> {
    // Chain synchronously (before any await) so the queue order matches the
    // order emit() called us. `.catch` on the tail keeps one failed ingest
    // from wedging the lane, while the returned promise still rejects.
    this.pendingIngests += 1;
    const run = this.ingestTail.then(() => this.ingestSerial(eventName, payload, context));
    this.ingestTail = run.catch(() => undefined);
    return run.finally(() => {
      this.pendingIngests -= 1;
    });
  }

  private async ingestSerial(
    eventName: string,
    payload: Record<string, unknown>,
    context?: EventPersistenceContext,
  ): Promise<PersistedFrame[]> {
    const frames = this.projector.project(eventName, payload);
    if (frames.length === 0) {
      return [];
    }
    this.validateRunFrames(eventName, frames);
    const persisted = await (
      this.deps.performance ?? performanceInstrumentation
    ).measure(
      'event.persist',
      {
        'stablehand.event.name': eventName,
        'stablehand.event.frame_count': frames.length,
        'stablehand.turn.id': frames[0]?.turnId ?? undefined,
        'stablehand.agent.id': frames[0]?.agentId,
        'stablehand.conversation.id': frames[0]?.conversationId ?? undefined,
      },
      () => this.persist(frames, eventName, payload, context),
    );
    if (persisted.length > 0) {
      this.fanOut(persisted);
    }
    return persisted;
  }

  /**
   * Restore the projector's per-turn state from durable frames before a
   * successor process continues a turn it took over (ADR 025). Runs on the
   * ingest lane so it cannot interleave with a concurrent ingest.
   */
  rehydrateTurnProjection(turnId: string): Promise<void> {
    const run = this.ingestTail.then(async () => {
      const rows = await this.deps.db.getTurnFrames(turnId);
      this.projector.restoreTurnTextState(
        turnId,
        rows.map((row) => this.rowToFrame(row)),
      );
    });
    this.ingestTail = run.catch(() => undefined);
    return run;
  }

  subscribe(subscriber: FrameSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Wait until every queued persist/fan-out operation has settled. */
  async drain(): Promise<void> {
    await this.ingestTail;
  }

  /** Durable replay of an agent's frames after a seq (run channel by default includes all). */
  async replaySince(
    agentId: string,
    afterSeq: number,
    options: {
      channels?: string[];
      limit?: number;
      throughSeq?: number;
    } = {},
  ): Promise<PersistedFrame[]> {
    const rows = await this.deps.db.getFramesSince(agentId, afterSeq, options);
    return rows.map((row) => this.rowToFrame(row));
  }

  /** Replay the tail of a specific turn (reconnect snapshots for in-flight turns). */
  async replayTurnTail(turnId: string, afterSeq = 0): Promise<PersistedFrame[]> {
    const rows = await this.deps.db.getTurnFrames(turnId, afterSeq);
    return rows.map((row) => this.rowToFrame(row));
  }

  private async persist(
    frames: CanonicalFrame[],
    eventName: string,
    sourcePayload: Record<string, unknown>,
    context?: EventPersistenceContext,
  ): Promise<PersistedFrame[]> {
    const hasSandboxSession = context?.sandboxSessionId !== undefined;
    const hasActiveGeneration = context?.activeGeneration !== undefined;
    if (hasSandboxSession !== hasActiveGeneration) {
      throw new Error(
        '[CanonicalLog] Sandbox callback persistence requires both session and active generation',
      );
    }
    if ((hasSandboxSession || hasActiveGeneration) && !context?.deliveryFence) {
      throw new Error(
        '[CanonicalLog] Sandbox callback persistence requires a delivery fence',
      );
    }
    const sandboxCallbackAuthority =
      context?.deliveryFence
      && context.sandboxSessionId !== undefined
      && context.activeGeneration !== undefined
        ? {
          sandboxSessionId: context.sandboxSessionId,
          expectedActiveGeneration: context.activeGeneration,
        }
        : undefined;
    const now = Date.now();
    const inserts = frames.map((frame) => ({
      type: frame.type,
      agentId: frame.agentId,
      payload: JSON.stringify(frame.body),
      turnId: frame.turnId ?? null,
      conversationId: frame.conversationId ?? null,
      channel: frame.channel,
      sourceType: frame.sourceType ?? null,
      sourcePayload: frame.sourcePayload ?? null,
    }));
    const isCommittedMessage = eventName === 'message.committed';
    const isUpdatedMessage = eventName === 'message.updated';
    const isTerminal = eventName === 'turn.completed';
    let seqs: number[];
    if (sandboxCallbackAuthority && context?.deliveryFence) {
      seqs = await this.deps.db.saveFencedEventBatch(
        inserts,
        context.deliveryFence,
        sandboxCallbackAuthority,
      );
    } else if (isCommittedMessage || isUpdatedMessage) {
      const messageId = sourcePayload.messageId;
      const targetRevision = isUpdatedMessage ? sourcePayload.messageRevision : 0;
      if (
        typeof messageId !== 'string'
        || !Number.isInteger(targetRevision)
        || Number(targetRevision) < 0
      ) {
        throw new Error(
          `[CanonicalLog] Cannot durably publish ${eventName}: invalid message identity/revision`,
        );
      }
      const publication = {
        messageId,
        targetRevision: Number(targetRevision),
      };
      seqs = context?.deliveryFence
        ? await this.deps.db.saveMessageEventBatch(
          inserts,
          publication,
          context.deliveryFence,
        )
        : await this.deps.db.saveMessageEventBatch(inserts, publication);
    } else if (isTerminal) {
      const turnId = sourcePayload.turnId;
      if (typeof turnId !== 'string' || turnId.length === 0) {
        throw new Error('[CanonicalLog] Cannot durably publish turn.completed: invalid turnId');
      }
      seqs = await this.deps.db.saveTerminalEventBatch(inserts, { turnId });
    } else if (
      context?.deliveryFence
      && (eventName === 'user.message' || eventName === 'turn.started')
    ) {
      const turnId = sourcePayload.turnId;
      if (typeof turnId !== 'string' || turnId.length === 0) {
        throw new Error(`[CanonicalLog] Cannot durably publish recovery ${eventName}: invalid turnId`);
      }
      seqs = await this.deps.db.saveRecoveryEventBatch(inserts, {
        turnId,
        sourceType: eventName,
        ...context.deliveryFence,
      });
    } else if (context?.deliveryFence) {
      seqs = await this.deps.db.saveFencedEventBatch(
        inserts,
        context.deliveryFence,
      );
    } else {
      seqs = await this.deps.db.saveEventBatch(inserts);
    }
    if (seqs.length === 0) {
      return [];
    }
    if (seqs.length !== frames.length) {
      throw new Error(
        `[CanonicalLog] Persisted ${seqs.length} seq(s) for ${frames.length} ${eventName} frame(s)`,
      );
    }
    return frames.map((frame, index) => ({
      ...frame,
      seq: seqs[index]!,
      createdAt: now,
    }));
  }

  private validateRunFrames(eventName: string, frames: CanonicalFrame[]): void {
    for (const frame of frames) {
      if (frame.channel !== 'run') continue;
      const result = CanonicalStreamEventSchema.safeParse(frame.body);
      if (result.success) continue;

      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(
        `[CanonicalLog] Invalid canonical run frame ` +
        `source=${eventName} type=${frame.type} agentId=${frame.agentId || '<missing>'} ` +
        `turnId=${frame.turnId ?? '<missing>'}: ${issues}`,
      );
    }
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
    sourceType?: string | null;
    sourcePayload?: string | null;
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
      sourceType: row.sourceType ?? null,
      sourcePayload: row.sourcePayload ?? null,
    };
  }
}
