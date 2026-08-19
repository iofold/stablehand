import { z } from 'zod';

/**
 * Canonical temporal schemas (ctx-iqzy).
 *
 * Every absolute timestamp on a public surface — REST, SSE/AG-UI frames,
 * webhook payloads, CLI JSON — is an integer epoch-milliseconds UTC number
 * and its field name ends in `At`. Sole exception: the X-Webhook-Timestamp
 * signing header, which is unix SECONDS by convention (Stripe-style) and is
 * documented where it is defined.
 *
 * Durations, ages, lags, and TTLs are integer milliseconds with an `Ms`
 * suffix. Sanctioned seconds exceptions, always `Sec`-suffixed: HTTP
 * retry hints (`retryAfterSec`, mirroring the Retry-After header) and
 * fields anchored to an external seconds API (`expiresInSec` for S3
 * presigning, `timeoutSec`/`defaultTimeoutSec` for container deadlines).
 *
 * Enforced by contract tests in time.test.ts.
 */
export const EpochMillisSchema = z.number().int().nonnegative();

/** Duration in integer milliseconds (never an absolute timestamp). */
export const DurationMsSchema = z.number().int().nonnegative();

export type EpochMillis = z.infer<typeof EpochMillisSchema>;
export type DurationMs = z.infer<typeof DurationMsSchema>;
