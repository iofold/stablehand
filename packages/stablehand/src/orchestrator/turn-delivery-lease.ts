import type { DatabaseRepository } from '../database/repository.js';
import { unrefTimer } from '../util/timing.js';
import type { TurnDeliveryFence } from './turn-delivery-fence.js';
import { newDeliveryOwnerId } from './instance-identity.js';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

interface Logger {
  warn(msg: string, ...args: unknown[]): void;
}

interface TurnDeliveryLeaseDeps {
  db: Pick<
    DatabaseRepository,
    | 'claimTurnDeliveryLease'
    | 'renewTurnDeliveryLease'
    | 'releaseTurnDeliveryLease'
  >;
  logger: Logger;
}

interface ClaimedTurnDeliveryLeaseDeps {
  db: Pick<
    DatabaseRepository,
    | 'renewTurnDeliveryLease'
    | 'releaseTurnDeliveryLease'
  >;
  logger: Logger;
}

export interface TurnDeliveryLeaseGuard {
  fence: TurnDeliveryFence;
  signal: AbortSignal;
  release(): Promise<void>;
}

export interface TurnDeliveryLeaseOptions {
  ownerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  /** ADR 024: also take over a dead earlier boot's unexpired lease. */
  previousBootTakeover?: { instancePrefix: string; ownBootPrefix: string };
}

export interface ClaimedTurnDeliveryLeaseOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * Own one turn from delivery admission through terminal persistence.
 *
 * Crash takeover uses the same database lease and monotonic token:
 * a healthy owner renews; a crashed owner expires; a replacement gets token+1.
 */
export async function acquireTurnDeliveryLease(
  deps: TurnDeliveryLeaseDeps,
  turnId: string,
  options: TurnDeliveryLeaseOptions = {},
): Promise<TurnDeliveryLeaseGuard | undefined> {
  const ownerId = options.ownerId ?? newDeliveryOwnerId();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  if (leaseMs <= 0 || heartbeatMs <= 0 || heartbeatMs >= leaseMs) {
    throw new Error('Turn delivery heartbeat must be positive and shorter than its lease');
  }

  const claimed = await deps.db.claimTurnDeliveryLease({
    turnId,
    ownerId,
    leaseDurationMs: leaseMs,
    ...(options.previousBootTakeover
      ? { previousBootTakeover: options.previousBootTakeover }
      : {}),
  });
  if (!claimed) {
    return undefined;
  }

  return monitorClaimedTurnDeliveryLease(
    deps,
    turnId,
    {
      ownerId,
      fenceToken: claimed.fenceToken,
    },
    { leaseMs, heartbeatMs, now },
  );
}

/**
 * Monitor and release a turn-delivery lease admitted by a larger atomic
 * transaction, such as an interrupt-resume attempt claim.
 */
export function monitorClaimedTurnDeliveryLease(
  deps: ClaimedTurnDeliveryLeaseDeps,
  turnId: string,
  fence: TurnDeliveryFence,
  options: ClaimedTurnDeliveryLeaseOptions = {},
): TurnDeliveryLeaseGuard {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  if (leaseMs <= 0 || heartbeatMs <= 0 || heartbeatMs >= leaseMs) {
    throw new Error('Turn delivery heartbeat must be positive and shorter than its lease');
  }

  const controller = new AbortController();
  let localLeaseDeadline = now() + leaseMs;
  let stopped = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalPromise: Promise<void> | undefined;

  const loseLease = (message: string, cause?: unknown): void => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(new Error(message, cause === undefined ? undefined : { cause }));
    deps.logger.warn(`[TurnDeliveryLease] ${message}`);
  };

  const armExpiry = (): void => {
    if (stopped || controller.signal.aborted) {
      return;
    }
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    const remainingMs = localLeaseDeadline - now();
    if (remainingMs <= 0) {
      loseLease(`delivery lease expired for turn ${turnId}`);
      return;
    }
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (now() >= localLeaseDeadline) {
        loseLease(`delivery lease expired for turn ${turnId}`);
      } else {
        armExpiry();
      }
    }, remainingMs);
    unrefTimer(expiryTimer);
  };

  armExpiry();
  const heartbeat = setInterval(() => {
    if (stopped || renewalPromise || controller.signal.aborted) {
      return;
    }
    renewalPromise = deps.db.renewTurnDeliveryLease(
      turnId,
      fence.ownerId,
      fence.fenceToken,
      leaseMs,
    ).then((renewed) => {
      if (!renewed) {
        loseLease(`lost delivery lease for turn ${turnId}`);
        return;
      }
      localLeaseDeadline = now() + leaseMs;
      armExpiry();
    }).catch((err: unknown) => {
      deps.logger.warn(`[TurnDeliveryLease] failed to renew turn ${turnId}:`, err);
      if (now() >= localLeaseDeadline) {
        loseLease(`delivery lease expired for turn ${turnId}`, err);
      }
    }).finally(() => {
      renewalPromise = undefined;
    });
  }, heartbeatMs);
  unrefTimer(heartbeat);

  return {
    fence,
    signal: controller.signal,
    release: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(heartbeat);
      // Keep the local expiry watchdog armed while an in-flight renewal
      // settles so a hung DB call cannot wedge release forever.
      const pendingRenewal = renewalPromise;
      if (pendingRenewal) {
        await Promise.race([
          pendingRenewal,
          new Promise<void>((resolve) => {
            if (controller.signal.aborted) {
              resolve();
              return;
            }
            controller.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      }
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
      }
      try {
        await deps.db.releaseTurnDeliveryLease(
          turnId,
          fence.ownerId,
          fence.fenceToken,
        );
      } catch (err) {
        deps.logger.warn(
          `[TurnDeliveryLease] failed to release turn ${turnId}; it will expire:`,
          err,
        );
      }
    },
  };
}
