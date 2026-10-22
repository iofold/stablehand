import { Code, ConnectError } from '@connectrpc/connect';
import type { TurnDeliveryCapability } from '@stablehand/proto/sandbox/v1';

import { cloneTurnDeliveryCapability } from './turn-delivery-capability.js';
import {
  isTurnDeliveryCapabilityExpired,
  waitForTurnDeliveryCapabilityChange,
  type TurnDeliveryContext,
} from './turn-delivery-context.js';

/**
 * Orchestrator callbacks that survive an orchestrator restart (ADR 025).
 *
 * While the orchestrator is unreachable, or while its successor has not yet
 * re-attached with a fresh capability, a callback waits and retries instead
 * of failing the tool call. The window is bounded by the delivery's orphan
 * grace; the delivery's own abort (kill, cancel, orphan timeout) ends it
 * sooner. Callers must keep request ids stable across attempts so the
 * orchestrator's dedup can return a result that was produced but not
 * delivered.
 */

const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4_000;
const TRANSPORT_ERROR_RE =
  /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket hang up|UND_ERR|other side closed|network|fetch failed/i;

export type CallbackFailureKind = 'transport' | 'stale_authority' | 'fatal';

export function classifyCallbackFailure(error: unknown): CallbackFailureKind {
  if (error instanceof ConnectError) {
    switch (error.code) {
      case Code.Unavailable:
      case Code.DeadlineExceeded:
      case Code.Aborted:
      case Code.Unknown:
      case Code.ResourceExhausted:
        return 'transport';
      case Code.FailedPrecondition:
        // The orchestrator refused this capability: its owner lost the turn,
        // or the lease lapsed. A successor will re-attach with a new one.
        return 'stale_authority';
      case Code.Internal:
      case Code.Canceled:
        return TRANSPORT_ERROR_RE.test(error.message) ? 'transport' : 'fatal';
      default:
        return 'fatal';
    }
  }
  if (error instanceof Error && TRANSPORT_ERROR_RE.test(error.message)) {
    return 'transport';
  }
  return 'fatal';
}

export interface CallbackWindowOptions {
  /** Upper bound on the whole retry window (defaults to the orphan grace). */
  windowMs?: number;
  /** Per-attempt timeout. */
  attemptTimeoutMs: number;
  now?: () => number;
  log?: (message: string) => void;
}

function abortReasonError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ConnectError('Turn delivery ended', Code.Canceled);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReasonError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReasonError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function attemptWithTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(
    new ConnectError(`callback attempt timed out after ${timeoutMs}ms`, Code.DeadlineExceeded),
  ), timeoutMs);
  timer.unref();
  try {
    return await call(AbortSignal.any([controller.signal, parent]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `call` with the delivery's current capability, retrying transport
 * failures with backoff and waiting for a rotated capability after a stale
 * authority refusal, until the window closes or the delivery aborts.
 */
export async function callWithinOrchestratorWindow<T>(
  context: TurnDeliveryContext,
  label: string,
  call: (capability: TurnDeliveryCapability, signal: AbortSignal) => Promise<T>,
  options: CallbackWindowOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  const signal = context.abortController.signal;
  const windowMs = options.windowMs ?? context.orphanGraceMs ?? 0;
  const deadline = now() + Math.max(0, windowMs);
  let delayMs = INITIAL_RETRY_DELAY_MS;
  let attempt = 0;

  while (true) {
    if (signal.aborted) throw abortReasonError(signal);

    if (isTurnDeliveryCapabilityExpired(context, now())) {
      const version = context.capabilityVersion ?? 0;
      log(`[callback-window] ${label}: delivery capability expired; waiting for the orchestrator to re-attach`);
      const changed = await waitForTurnDeliveryCapabilityChange(context, version, deadline);
      if (signal.aborted) throw abortReasonError(signal);
      if (!changed || isTurnDeliveryCapabilityExpired(context, now())) {
        throw new ConnectError(
          `${label} could not reach a live orchestrator within ${windowMs}ms (delivery capability expired)`,
          Code.Unavailable,
        );
      }
    }

    const version = context.capabilityVersion ?? 0;
    const capability = cloneTurnDeliveryCapability(context.capability);
    attempt += 1;
    try {
      return await attemptWithTimeout(
        (attemptSignal) => call(capability, attemptSignal),
        options.attemptTimeoutMs,
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw abortReasonError(signal);
      const kind = classifyCallbackFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      if (kind === 'fatal') throw error;
      if (now() >= deadline) {
        throw new ConnectError(
          `${label} could not reach a live orchestrator within ${windowMs}ms after ${attempt} attempt(s): ${message}`,
          Code.Unavailable,
          undefined,
          undefined,
          error,
        );
      }
      if (kind === 'stale_authority') {
        log(`[callback-window] ${label}: orchestrator refused the current capability (${message}); waiting for re-attach`);
        const changed = await waitForTurnDeliveryCapabilityChange(context, version, deadline);
        if (signal.aborted) throw abortReasonError(signal);
        if (!changed) {
          throw new ConnectError(
            `${label} was refused by the orchestrator and no successor re-attached within ${windowMs}ms: ${message}`,
            Code.FailedPrecondition,
            undefined,
            undefined,
            error,
          );
        }
        delayMs = INITIAL_RETRY_DELAY_MS;
        continue;
      }
      log(`[callback-window] ${label}: attempt ${attempt} failed (${message}); retrying in ${delayMs}ms`);
      await sleep(Math.min(delayMs, Math.max(0, deadline - now())), signal);
      delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
    }
  }
}
