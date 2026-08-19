/**
 * ctx-psax acceptance — AG-UI compat run stream.
 *
 * (a) Reconnect lost-frame window: the live subscription is registered before
 *     the replayTurnTail() snapshot read, so a frame committing while the query
 *     is in flight is buffered and flushed instead of reaching nobody. Frames
 *     carried by both paths are delivered once, and a client presenting
 *     Last-Event-ID resumes from its cursor.
 * (b) Bounded per-client writes: writeEvent() goes through BoundedSseWriter, so
 *     a stalled consumer is capped and disconnected like an SSEManager client.
 *
 * Was a red repro (assertions described the buggy behaviour); now asserts the
 * fixed behaviour.
 */
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { agUiCompatRoutes } from './route.js';
import { CanonicalLog } from '../canonical/canonical-log.js';
import { SSEManager, formatSeqId } from '../sse.js';

const AGENT = 'agent-1';
const RUN = 'run-1';
const THREAD = 'thread-1';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

interface Row {
  seq: number;
  type: string;
  agentId: string;
  payload: string;
  createdAt: number;
  turnId: string | null;
  conversationId: string | null;
  channel: string;
}

interface QueryHooks {
  /** Runs before the snapshot is fixed — commits here land in the result set. */
  onTurnFramesQuery?: () => Promise<void>;
  /** Runs after the snapshot is fixed — commits here do not. */
  onTurnFramesSnapshot?: () => Promise<void>;
}

function createCanonicalDb(hooks: QueryHooks = {}) {
  let nextSeq = 100;
  const rows: Row[] = [];
  const save = async (frames: Array<Record<string, unknown>>): Promise<number[]> => {
    const seqs = frames.map(() => ++nextSeq);
    frames.forEach((frame, index) => {
      rows.push({ ...(frame as unknown as Row), seq: seqs[index]!, createdAt: Date.now() });
    });
    return seqs;
  };
  const getTurnFrames = vi.fn(async (turnId: string, afterSeq = 0) => {
    if (hooks.onTurnFramesQuery) await hooks.onTurnFramesQuery();
    // A real query observes a snapshot fixed at statement time. Rows committed
    // while this promise is outstanding are NOT in the returned result set.
    const snapshot = rows.filter((row) => row.turnId === turnId && row.seq > afterSeq);
    if (hooks.onTurnFramesSnapshot) await hooks.onTurnFramesSnapshot();
    return snapshot;
  });
  const db = {
    saveEventBatch: vi.fn(save),
    saveFencedEventBatch: vi.fn(save),
    saveRecoveryEventBatch: vi.fn(save),
    saveMessageEventBatch: vi.fn(save),
    saveTerminalEventBatch: vi.fn(save),
    getFramesSince: vi.fn(async () => []),
    getTurnFrames,
  };
  return { db, rows, getTurnFrames };
}

function createLog(db: unknown): CanonicalLog {
  return new CanonicalLog({
    db: db as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

/** Register the route against a stub app and hand back the raw handler. */
async function captureHandler(canonicalLog: CanonicalLog): Promise<Handler> {
  let handler: Handler | undefined;
  const app = {
    post: vi.fn((_path: string, optionsOrHandler: unknown, registered?: Handler) => {
      handler = registered ?? (optionsOrHandler as Handler);
    }),
  } as unknown as FastifyInstance;

  await agUiCompatRoutes(app, {
    db: {
      getAgent: vi.fn().mockResolvedValue({ id: AGENT }),
      // An in-flight turn: this is the reconnect path (isReconnect === true).
      getTurn: vi.fn().mockResolvedValue({
        id: RUN,
        agentId: AGENT,
        conversationId: THREAD,
        completedAt: null,
      }),
      getMessages: vi.fn().mockResolvedValue([]),
    } as never,
    eventBus: {} as never,
    turnStartupService: {} as never,
    canonicalLog,
  });

  if (!handler) throw new Error('AG-UI handler was not registered');
  return handler;
}

/** Sink that accepts everything immediately — records the wire. */
function drainingSink(chunks: string[]) {
  return Object.assign(
    new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }),
    { writeHead: vi.fn() },
  );
}

/** Sink that never completes a write — a real stalled TCP consumer. */
function stalledSink() {
  return Object.assign(
    new Writable({
      highWaterMark: 16 * 1024,
      write() {
        /* never invokes the callback: the socket is wedged */
      },
    }),
    { writeHead: vi.fn() },
  );
}

function makeRequest(
  raw: EventEmitter,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): FastifyRequest {
  return {
    params: { id: AGENT },
    body,
    headers,
    raw,
  } as unknown as FastifyRequest;
}

function makeReply(raw: unknown): FastifyReply {
  return {
    raw,
    getHeaders: vi.fn().mockReturnValue({}),
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as unknown as FastifyReply;
}

function ingestDelta(log: CanonicalLog, delta: string, timestamp: number): Promise<unknown> {
  return log.ingest('message.delta', {
    turnId: RUN,
    agentId: AGENT,
    conversationId: THREAD,
    messageId: 'sandbox-msg',
    delta,
    timestamp,
  });
}

function seedTurn(log: CanonicalLog): Promise<unknown> {
  return log.ingest('turn.started', {
    turnId: RUN,
    sandboxSessionId: 'sandbox-1',
    agentId: AGENT,
    conversationId: THREAD,
    mode: 'interactive',
    taskDescription: 'hello',
    timestamp: 1_000,
  });
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A promise plus the callback that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('ctx-psax (a) reconnect lost-frame window', () => {
  it('delivers frames committed between the replay snapshot and the live subscription', async () => {
    const snapshotTaken = gate();
    const queryGate = gate();

    const { db } = createCanonicalDb({
      onTurnFramesSnapshot: async () => {
        snapshotTaken.open();
        await queryGate.wait;
      },
    });
    const log = createLog(db);

    // Frames already durable before the client reconnects.
    await seedTurn(log);
    await ingestDelta(log, 'BEFORE-RECONNECT', 1_001);

    const handler = await captureHandler(log);
    const wire: string[] = [];
    const requestRaw = new EventEmitter();
    const inFlight = handler(
      makeRequest(requestRaw, { runId: RUN, threadId: THREAD, messages: [] }),
      makeReply(drainingSink(wire)),
    );

    await snapshotTaken.wait;
    // The turn is live: the sandbox streams a delta right now. It persists and
    // fans out while the replay query is still outstanding.
    await ingestDelta(log, 'GAP-DELTA', 1_002);
    queryGate.open();
    await inFlight;

    await ingestDelta(log, 'AFTER-SUBSCRIBE', 1_003);

    const transcript = wire.join('');
    expect(transcript).toContain('BEFORE-RECONNECT');
    // The fix: buffered by the pre-registered subscription, flushed after replay.
    expect(transcript).toContain('GAP-DELTA');
    expect(transcript).toContain('AFTER-SUBSCRIBE');

    // Ordering is still seq order: the buffered frame lands before the live one.
    expect(transcript.indexOf('BEFORE-RECONNECT'))
      .toBeLessThan(transcript.indexOf('GAP-DELTA'));
    expect(transcript.indexOf('GAP-DELTA'))
      .toBeLessThan(transcript.indexOf('AFTER-SUBSCRIBE'));

    // Every frame now carries a resumable durable id.
    expect(transcript).toMatch(/^id: \d{12}$/m);

    requestRaw.emit('close');
  });

  it('delivers a frame carried by both the replay and the live subscription exactly once', async () => {
    const queryStarted = gate();
    const queryGate = gate();

    const { db } = createCanonicalDb({
      onTurnFramesQuery: async () => {
        queryStarted.open();
        await queryGate.wait;
      },
    });
    const log = createLog(db);

    await seedTurn(log);

    const handler = await captureHandler(log);
    const wire: string[] = [];
    const requestRaw = new EventEmitter();
    const inFlight = handler(
      makeRequest(requestRaw, { runId: RUN, threadId: THREAD, messages: [] }),
      makeReply(drainingSink(wire)),
    );

    await queryStarted.wait;
    // Commits before the snapshot is fixed: the subscription sees it live AND
    // the replay returns it. Exactly one copy may reach the wire.
    await ingestDelta(log, 'OVERLAP-DELTA', 1_002);
    queryGate.open();
    await inFlight;

    expect(occurrences(wire.join(''), 'OVERLAP-DELTA')).toBe(1);

    requestRaw.emit('close');
  });

  it('resumes from Last-Event-ID instead of replaying the whole turn tail', async () => {
    const { db, getTurnFrames } = createCanonicalDb();
    const log = createLog(db);

    await seedTurn(log);
    await ingestDelta(log, 'ALREADY-SEEN', 1_001);
    const durable = await log.replayTurnTail(RUN);
    const cursor = Math.max(...durable.map((frame) => frame.seq));
    getTurnFrames.mockClear();

    const handler = await captureHandler(log);
    const wire: string[] = [];
    const requestRaw = new EventEmitter();
    await handler(
      makeRequest(
        requestRaw,
        { runId: RUN, threadId: THREAD, messages: [] },
        { 'last-event-id': formatSeqId(cursor) },
      ),
      makeReply(drainingSink(wire)),
    );

    await ingestDelta(log, 'AFTER-CURSOR', 1_002);

    // The client's cursor rides the route's existing afterSeq argument.
    expect(getTurnFrames).toHaveBeenCalledWith(RUN, cursor);

    const transcript = wire.join('');
    expect(transcript).not.toContain('ALREADY-SEEN');
    expect(transcript).toContain('AFTER-CURSOR');
    expect(transcript).toContain(`id: ${formatSeqId(cursor + 1)}`);

    requestRaw.emit('close');
  });
});

describe('ctx-psax (b) unbounded per-client writes', () => {
  it('caps and disconnects a stalled client, like SSEManager does', async () => {
    const FRAMES = 2_000;
    const PAYLOAD = 16 * 1024;
    const filler = 'x'.repeat(PAYLOAD);

    const { db } = createCanonicalDb();
    const log = createLog(db);
    const handler = await captureHandler(log);

    const stalled = stalledSink();
    const requestRaw = new EventEmitter();
    await handler(
      makeRequest(requestRaw, { runId: RUN, threadId: THREAD, messages: [] }),
      makeReply(stalled),
    );

    for (let i = 0; i < FRAMES; i += 1) {
      await ingestDelta(log, filler, 2_000 + i);
    }

    const compatBuffered = stalled.writableLength;
    // The queue is bounded and the wedged consumer is dropped: the response
    // stream retains one chunk, not ~32 MiB of undelivered frames.
    expect(compatBuffered).toBeLessThan(2 * 1024 * 1024);
    expect(stalled.writableEnded).toBe(true);

    // Parity: the same stalled consumer on the agent SSE route.
    const sse = new SSEManager();
    const sseStalled = stalledSink();
    sse.subscribe(AGENT, makeReply(sseStalled));
    for (let i = 0; i < FRAMES; i += 1) {
      sse.broadcastFrame(AGENT, { type: 'TEXT_MESSAGE_CONTENT', delta: filler }, i + 1);
    }
    const sseBuffered = sseStalled.writableLength;

    expect(sse.getClientCount(AGENT)).toBe(0); // slow client evicted
    expect(compatBuffered).toBeLessThan(sseBuffered * 2);

    console.info(
      `[ctx-psax b] compat buffered=${compatBuffered} bytes; `
      + `SSEManager buffered=${sseBuffered} bytes after ${FRAMES} x ${PAYLOAD}B frames`,
    );

    sse.shutdown();
    requestRaw.emit('close');
  });
});
