import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { TurnDeliveryCapability } from '@ctxmill/proto/sandbox/v1';

import {
  cloneTurnDeliveryCapability,
  type TurnDeliveryIdentity,
} from './turn-delivery-capability.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TurnDeliveryContext {
  readonly identity: TurnDeliveryIdentity;
  readonly abortController: AbortController;
  readonly turnSecrets?: Readonly<Record<string, string>>;
  capability: TurnDeliveryCapability;
  leaseExpiresAtMs: number;
  expiryTimer?: NodeJS.Timeout;
  ptcToken?: string;
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

export function assertTurnDeliveryContextCurrent(
  context: TurnDeliveryContext,
  nowMs = Date.now(),
): void {
  if (context.abortController.signal.aborted || nowMs >= context.leaseExpiresAtMs) {
    const error = expiredError(context.identity.turnId);
    if (!context.abortController.signal.aborted) {
      context.abortController.abort(error);
    }
    throw error;
  }
}

export function snapshotTurnDeliveryCapability(
  context: TurnDeliveryContext,
  nowMs = Date.now(),
): TurnDeliveryCapability {
  assertTurnDeliveryContextCurrent(context, nowMs);
  return cloneTurnDeliveryCapability(context.capability);
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
    || nowMs >= context.leaseExpiresAtMs
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
