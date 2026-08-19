/**
 * ctx-bh1u — canonical ingest lane backpressure.
 *
 * The canonical event lane (CanonicalLog.ingest) is a single serialized
 * promise chain. Before the fix it had no depth bound, so an external flood
 * through POST /api/triggers/emit grew it until the heap gave out. The fix
 * adds a depth gauge (CanonicalLog.depth) and a typed 429 admission at the
 * external ingress ONLY (createCanonicalIngestAdmission), mirroring the turn
 * queue — internal producers are never shed.
 *
 * These assertions describe the FIXED behaviour.
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { CanonicalLog } from '../canonical-log.js';
import { TypedEventBus } from '../../../events/bus.js';
import {
  IngestQueueFullError,
  createCanonicalIngestAdmission,
} from '../../canonical-ingest-admission.js';
import { triggerRoutes } from '../../routes/triggers.js';

const AGENT = 'agent-1';

/** CanonicalLog whose persistence sink is paused: the lane head never returns. */
function createPausedSpine() {
  let releaseSink: () => void = () => {};
  const sinkGate = new Promise<void>((resolve) => {
    releaseSink = resolve;
  });
  let entered = 0;
  let nextSeq = 0;

  const save = async (frames: Array<Record<string, unknown>>): Promise<number[]> => {
    entered += 1;
    await sinkGate;
    return frames.map(() => ++nextSeq);
  };
  const db = {
    saveEventBatch: vi.fn(save),
    saveFencedEventBatch: vi.fn(save),
    saveRecoveryEventBatch: vi.fn(save),
    saveMessageEventBatch: vi.fn(save),
    saveTerminalEventBatch: vi.fn(save),
    getFramesSince: vi.fn(async () => []),
    getTurnFrames: vi.fn(async () => []),
  };
  const canonicalLog = new CanonicalLog({
    db: db as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  // Verbatim copy of the production wiring in config/container.ts:283-292.
  const eventBus = new TypedEventBus({
    persistEvent: async (type, _agentId, payload, parsedPayload, context) => {
      const persisted = await canonicalLog.ingest(
        type,
        parsedPayload ?? JSON.parse(payload) as Record<string, unknown>,
        context,
      );
      return persisted.length > 0;
    },
  });

  return {
    canonicalLog,
    eventBus,
    releaseSink,
    entered: () => entered,
  };
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ctx-bh1u canonical ingest backpressure', () => {
  it('exposes a live depth gauge that rises with the parked lane and returns to zero', async () => {
    const spine = createPausedSpine();
    expect(spine.canonicalLog.depth).toBe(0);

    const N = 20;
    const inFlight = Array.from({ length: N }, (_, i) =>
      spine.eventBus.emitCustomAsync('custom.flood', AGENT, {
        type: 'custom.flood',
        agentId: AGENT,
        payload: { index: i },
      }));

    await tick();
    // Every ingest is chained and parked on the stalled sink.
    expect(spine.canonicalLog.depth).toBe(N);

    spine.releaseSink();
    await Promise.all(inFlight);
    expect(spine.canonicalLog.depth).toBe(0);
  }, 30_000);

  it('admission refuses with a typed 429 + Retry-After at or above the cap', async () => {
    let depth = 0;
    const admission = createCanonicalIngestAdmission({
      depth: () => depth,
      settings: async () => ({ maxIngestQueueDepth: 3 }),
    });

    // Below the cap: accepted.
    depth = 2;
    await expect(admission.check()).resolves.toBeUndefined();

    // At the cap: refused with the typed shape the route surfaces.
    depth = 3;
    const refusal = await admission.check().then(
      () => null,
      (error: unknown) => error as IngestQueueFullError,
    );
    expect(refusal).toBeInstanceOf(IngestQueueFullError);
    expect(refusal?.code).toBe('ingest_queue_full');
    expect(refusal?.statusCode).toBe(429);
    expect(refusal?.retryAfterSec).toBe(5);
    expect(refusal?.depth).toBe(3);
    expect(refusal?.limit).toBe(3);
  });

  it('sheds POST /api/triggers/emit with 429 once the lane is at the cap', async () => {
    const CAP = 5;
    const spine = createPausedSpine();
    const app = Fastify({ logger: false });
    await app.register(triggerRoutes, {
      prefix: '/api/triggers',
      triggerManager: {
        emitCustomEventAsync: (
          type: string,
          agentId: string | undefined,
          payload: Record<string, unknown>,
        ) => spine.eventBus.emitCustomAsync(type, agentId ?? '', payload),
      } as never,
      db: {} as never,
      ingestAdmission: createCanonicalIngestAdmission({
        depth: () => spine.canonicalLog.depth,
        settings: async () => ({ maxIngestQueueDepth: CAP }),
      }),
    });

    // Fill the lane to the cap; these park on the stalled sink.
    const filling = Array.from({ length: CAP }, (_, index) =>
      app.inject({
        method: 'POST',
        url: '/api/triggers/emit',
        payload: { type: 'custom.flood', agentId: AGENT, payload: { index } },
      }));
    await tick();
    expect(spine.canonicalLog.depth).toBe(CAP);

    // The lane is full: the next emit is shed before it enqueues anything.
    const shed = await app.inject({
      method: 'POST',
      url: '/api/triggers/emit',
      payload: { type: 'custom.flood', agentId: AGENT, payload: { index: 999 } },
    });
    expect(shed.statusCode).toBe(429);
    expect(shed.headers['retry-after']).toBe('5');
    const body = shed.json();
    // ctx-iqzy S12: turn-start envelope family — error=human, code=machine.
    expect(body.code).toBe('ingest_queue_full');
    expect(body.error).toContain('ingest lane is full');
    expect(body.retryAfterSec).toBe(5);
    // Nothing extra entered the lane — the shed request enqueued no frame.
    expect(spine.canonicalLog.depth).toBe(CAP);

    spine.releaseSink();
    await Promise.all(filling);
    await app.close();
  }, 30_000);
});
