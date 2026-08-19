/**
 * Durable canonical-ingest admission (ctx-bh1u). The canonical event lane
 * (CanonicalLog.ingest) is a single serialized promise chain with no depth
 * bound; an external flood through POST /api/triggers/emit grows it until the
 * heap gives out. This mirrors the turn-queue admission (ctx-z5k0): rejection
 * happens at the external ingress BEFORE the emit, with a typed 429 +
 * Retry-After, so a refused caller owns the retry with nothing half-accepted.
 *
 * The cap is consulted ONLY by the external route — internal producers
 * (sandbox text deltas, tool/terminal frames) must never be shed, so they
 * never pass through this check; they enqueue directly on the lane.
 */
export class IngestQueueFullError extends Error {
  readonly code = 'ingest_queue_full';
  readonly statusCode = 429;
  readonly retryAfterSec = 5;

  constructor(
    readonly depth: number,
    readonly limit: number,
  ) {
    super(`Canonical ingest lane is full (${depth}/${limit} pending). Retry later.`);
    this.name = 'IngestQueueFullError';
  }
}

export interface CanonicalIngestAdmission {
  check(): Promise<void>;
}

export interface CanonicalIngestAdmissionDeps {
  /** Current lane depth (CanonicalLog.depth). */
  depth: () => number;
  settings: () => Promise<{ maxIngestQueueDepth: number }>;
}

export function createCanonicalIngestAdmission(
  deps: CanonicalIngestAdmissionDeps,
): CanonicalIngestAdmission {
  return {
    async check(): Promise<void> {
      const { maxIngestQueueDepth } = await deps.settings();
      const depth = deps.depth();
      if (depth >= maxIngestQueueDepth) {
        throw new IngestQueueFullError(depth, maxIngestQueueDepth);
      }
    },
  };
}
