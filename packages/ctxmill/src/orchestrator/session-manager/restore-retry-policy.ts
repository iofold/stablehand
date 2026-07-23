import { Code, ConnectError } from '@connectrpc/connect';

/**
 * Restore retry policy per ADR 013.
 *
 * - Up to 3 auto-retries on retryable RESTORING failures with backoff 5s / 15s / 45s.
 * - After 3 fails the session lands in CHECKPOINTED with `last_restore_error` populated.
 * - Non-retryable failures bypass the retry loop and go directly to TERMINATED.
 */
export const MAX_RESTORE_ATTEMPTS = 3;

/** Bound how long a request waits to join another replica's active restore. */
export const RESTORE_JOIN_POLL_MS = 250;
export const RESTORE_JOIN_MAX_POLLS = 120;

/**
 * Backoff schedule (in milliseconds). Index 0 is the delay before attempt 1
 * (i.e. the first auto-retry after the initial failure), index 1 before
 * attempt 2, and so on.
 */
export const RESTORE_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000];

/** A short, machine-classifiable category for the failure. */
export type RestoreFailureCategory = 'retryable' | 'non_retryable';

export interface RestoreFailureClassification {
  category: RestoreFailureCategory;
  /** Human-readable summary suitable for `last_restore_error`. */
  message: string;
}

/**
 * Marker error used by the recovery coordinator to indicate a checkpoint is
 * unusable. Always non-retryable.
 */
export class InvalidCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCheckpointError';
  }
}

const NON_RETRYABLE_CONNECT_CODES: ReadonlySet<Code> = new Set([
  Code.InvalidArgument,
  Code.FailedPrecondition,
  Code.PermissionDenied,
  Code.Unauthenticated,
  Code.NotFound,
  Code.Unimplemented,
]);

const RETRYABLE_CONNECT_CODES: ReadonlySet<Code> = new Set([
  Code.Unavailable,
  Code.DeadlineExceeded,
  Code.Internal,
  Code.ResourceExhausted,
  Code.Aborted,
]);

const RETRYABLE_NETWORK_PATTERN = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH/;

export function isInvalidCheckpointError(err: unknown): err is InvalidCheckpointError {
  return err instanceof InvalidCheckpointError;
}

/**
 * Classify a restore failure as retryable or non-retryable per ADR 013.
 *
 * Defaults to retryable when the error type is unknown — a transient unknown
 * error should not strand the user; the retry loop will eventually give up.
 */
export function classifyRestoreFailure(err: unknown): RestoreFailureClassification {
  if (isInvalidCheckpointError(err)) {
    return { category: 'non_retryable', message: err.message };
  }

  if (err instanceof ConnectError) {
    if (NON_RETRYABLE_CONNECT_CODES.has(err.code)) {
      return { category: 'non_retryable', message: `${err.code}: ${err.rawMessage}` };
    }
    if (RETRYABLE_CONNECT_CODES.has(err.code)) {
      return { category: 'retryable', message: `${err.code}: ${err.rawMessage}` };
    }
    return { category: 'retryable', message: `${err.code}: ${err.rawMessage}` };
  }

  if (err instanceof Error) {
    if (RETRYABLE_NETWORK_PATTERN.test(err.message)) {
      return { category: 'retryable', message: err.message };
    }
    return { category: 'retryable', message: err.message };
  }

  return { category: 'retryable', message: String(err) };
}

/**
 * Returns the delay before the given retry attempt (1-indexed).
 * Returns undefined when the attempt is past the auto-retry budget.
 */
export function backoffForAttempt(attempt: number): number | undefined {
  if (attempt < 1 || attempt > RESTORE_BACKOFF_MS.length) return undefined;
  return RESTORE_BACKOFF_MS[attempt - 1];
}

/**
 * Decide what to do after a restore failure given the current attempt count
 * (the count of failed attempts so far, including this one).
 *
 * - retryable + attempts < MAX_RESTORE_ATTEMPTS  → keep retrying
 * - retryable + attempts >= MAX_RESTORE_ATTEMPTS → land in CHECKPOINTED
 * - non-retryable                                 → land in TERMINATED
 */
export interface RestoreOutcome {
  /** Where the session should land after this failure. */
  toStatus: 'CHECKPOINTED' | 'TERMINATED' | 'RETRY';
  /** Delay (ms) before the next retry attempt; only present when toStatus === 'RETRY'. */
  retryDelayMs?: number;
  classification: RestoreFailureClassification;
}

export function decideRestoreOutcome(
  err: unknown,
  failedAttempts: number,
): RestoreOutcome {
  const classification = classifyRestoreFailure(err);

  if (classification.category === 'non_retryable') {
    return { toStatus: 'TERMINATED', classification };
  }

  if (failedAttempts >= MAX_RESTORE_ATTEMPTS) {
    return { toStatus: 'CHECKPOINTED', classification };
  }

  const retryDelayMs = backoffForAttempt(failedAttempts);
  return {
    toStatus: 'RETRY',
    classification,
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
  };
}
