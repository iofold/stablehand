import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { TurnDeliveryCapability } from '@stablehand/proto/sandbox/v1';

import {
  cloneTurnDeliveryCapability,
  type TurnDeliveryIdentity,
} from './turn-delivery-capability.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TurnDeliveryContext {
  /**
   * Current delivery authority. Re-attach after an orchestrator takeover
   * replaces it with the successor's higher fence (ADR 025).
   */
  identity: TurnDeliveryIdentity;
  readonly abortController: AbortController;
  readonly turnSecrets?: Readonly<Record<string, string>>;
  capability: TurnDeliveryCapability;
  leaseExpiresAtMs: number;
  expiryTimer?: NodeJS.Timeout;
  ptcToken?: string;
  /**
   * How long the turn may keep running without a reachable orchestrator
   * (ADR 025). Zero keeps the legacy rule: capability expiry aborts the turn.
   * Above zero, expiry only blocks callbacks until a successor re-attaches.
   */
  orphanGraceMs?: number;
  /** Bumped whenever the capability is renewed or rotated. */
  capabilityVersion?: number;
  /** Called (grace mode only) when the capability expires instead of aborting. */
  onCapabilityExpired?: () => void;
  capabilityWaiters?: Set<() => void>;
}

const turnDeliveryStorage = new AsyncLocalStorage<TurnDeliveryContext>();
const ptcDeliveryContexts = new Map<string, TurnDeliveryContext>();

function expiredError(turnId: string): ConnectError {
  return new ConnectError(
    `Turn delivery capability expired for turn ${turnId}`,
    Code.FailedPrecondition,
  );
}

export function runWithTurnDeliveryContext<T>(
  context: TurnDeliveryContext,
  callback: () => T,
): T {
  return turnDeliveryStorage.run(context, callback);
}

export function getTurnDeliveryContext(): TurnDeliveryContext | undefined {
  return turnDeliveryStorage.getStore();
}

export function requireCurrentTurnSecrets(): Readonly<Record<string, string>> {
  const context = requireTurnDeliveryContext();
  assertTurnDeliveryContextCurrent(context);
  return context.turnSecrets ?? {};
}

export function requireTurnDeliveryContext(
  expected?: Partial<Pick<TurnDeliveryIdentity, 'turnId' | 'sandboxSessionId' | 'agentId'>>,
): TurnDeliveryContext {
  const context = getTurnDeliveryContext();
  if (!context) {
    throw new ConnectError(
      'Turn delivery context is required for sandbox callback',
      Code.FailedPrecondition,
    );
  }
  if (
    expected?.turnId !== undefined
    && expected.turnId !== context.identity.turnId
  ) {
    throw new ConnectError(
      'Turn delivery context turn mismatch',
      Code.FailedPrecondition,
    );
  }
  if (
    expected?.sandboxSessionId !== undefined
    && expected.sandboxSessionId !== context.identity.sandboxSessionId
  ) {
    throw new ConnectError(
      'Turn delivery context session mismatch',
      Code.FailedPrecondition,
    );
  }
  if (
    expected?.agentId !== undefined
    && expected.agentId !== context.identity.agentId
  ) {
    throw new ConnectError(
      'Turn delivery context agent mismatch',
      Code.FailedPrecondition,
    );
  }
  return context;
}

function hasOrphanGrace(context: TurnDeliveryContext): boolean {
  return (context.orphanGraceMs ?? 0) > 0;
}

/**
 * Throws once the delivery can no longer make progress. In grace mode an
 * expired capability does not stop the harness: only an abort does, and the
 * orphan timer owns that decision (ADR 025).
 */
export function assertTurnDeliveryContextCurrent(
  context: TurnDeliveryContext,
  nowMs = Date.now(),
): void {
  if (context.abortController.signal.aborted) {
    const reason = context.abortController.signal.reason;
    throw hasOrphanGrace(context) && reason instanceof Error
      ? reason
      : expiredError(context.identity.turnId);
  }
  if (!hasOrphanGrace(context) && nowMs >= context.leaseExpiresAtMs) {
    const error = expiredError(context.identity.turnId);
    context.abortController.abort(error);
    throw error;
  }
}

export function isTurnDeliveryCapabilityExpired(
  context: TurnDeliveryContext,
  nowMs = Date.now(),
): boolean {
  return nowMs >= context.leaseExpiresAtMs;
}

export function snapshotTurnDeliveryCapability(
  context: TurnDeliveryContext,
  nowMs = Date.now(),
): TurnDeliveryCapability {
  assertTurnDeliveryContextCurrent(context, nowMs);
  if (nowMs >= context.leaseExpiresAtMs) {
    throw expiredError(context.identity.turnId);
  }
  return cloneTurnDeliveryCapability(context.capability);
}

/**
 * Replace the delivery's authority in place (renewal or successor
 * re-attach) and wake callbacks that were waiting for a usable capability.
 */
export function installTurnDeliveryCapability(
  context: TurnDeliveryContext,
  next: {
    identity: TurnDeliveryIdentity;
    capability: TurnDeliveryCapability;
    leaseExpiresAtMs: number;
  },
): void {
  context.identity = next.identity;
  context.capability = next.capability;
  context.leaseExpiresAtMs = next.leaseExpiresAtMs;
  context.capabilityVersion = (context.capabilityVersion ?? 0) + 1;
  armTurnDeliveryExpiry(context);
  const waiters = context.capabilityWaiters;
  if (waiters) {
    context.capabilityWaiters = new Set();
    for (const wake of waiters) wake();
  }
}

/**
 * Wait until the capability version moves past `afterVersion`, the deadline
 * passes, or the delivery aborts. Resolves true only on a version change.
 */
export async function waitForTurnDeliveryCapabilityChange(
  context: TurnDeliveryContext,
  afterVersion: number,
  deadlineMs: number,
): Promise<boolean> {
  if ((context.capabilityVersion ?? 0) > afterVersion) return true;
  const signal = context.abortController.signal;
  if (signal.aborted) return false;
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return false;
  return await new Promise<boolean>((resolve) => {
    const waiters = context.capabilityWaiters ?? new Set<() => void>();
    context.capabilityWaiters = waiters;
    const finish = (changed: boolean): void => {
      clearTimeout(timer);
      context.capabilityWaiters?.delete(onChange);
      signal.removeEventListener('abort', onAbort);
      resolve(changed);
    };
    const onChange = (): void => finish(true);
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(false), Math.min(remainingMs, MAX_TIMER_DELAY_MS));
    timer.unref();
    waiters.add(onChange);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function clearTurnDeliveryExpiry(context: TurnDeliveryContext): void {
  if (context.expiryTimer) {
    clearTimeout(context.expiryTimer);
    context.expiryTimer = undefined;
  }
}

export function registerPtcTurnDeliveryContext(
  context: TurnDeliveryContext,
): string {
  revokePtcTurnDeliveryContext(context);
  const token = randomBytes(32).toString('base64url');
  context.ptcToken = token;
  ptcDeliveryContexts.set(token, context);
  return token;
}

export function resolvePtcTurnDeliveryContext(
  token: string,
  nowMs = Date.now(),
): TurnDeliveryContext | undefined {
  const context = ptcDeliveryContexts.get(token);
  if (!context) return undefined;
  if (
    context.abortController.signal.aborted
    || (!hasOrphanGrace(context) && nowMs >= context.leaseExpiresAtMs)
  ) {
    revokePtcTurnDeliveryContext(context);
    return undefined;
  }
  return context;
}

export function revokePtcTurnDeliveryContext(
  context: TurnDeliveryContext,
): void {
  if (!context.ptcToken) return;
  if (ptcDeliveryContexts.get(context.ptcToken) === context) {
    ptcDeliveryContexts.delete(context.ptcToken);
  }
  context.ptcToken = undefined;
}

export function armTurnDeliveryExpiry(context: TurnDeliveryContext): void {
  clearTurnDeliveryExpiry(context);

  const schedule = (): void => {
    const remainingMs = context.leaseExpiresAtMs - Date.now();
    if (remainingMs <= 0) {
      if (hasOrphanGrace(context)) {
        // ADR 025: the orchestrator stopped renewing. Keep the harness
        // running; callbacks wait for a successor and the orphan timer
        // decides when to give up.
        context.onCapabilityExpired?.();
        return;
      }
      revokePtcTurnDeliveryContext(context);
      if (!context.abortController.signal.aborted) {
        context.abortController.abort(expiredError(context.identity.turnId));
      }
      return;
    }

    context.expiryTimer = setTimeout(
      () => {
        context.expiryTimer = undefined;
        schedule();
      },
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
    context.expiryTimer.unref();
  };

  schedule();
}
