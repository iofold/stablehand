import { randomUUID } from 'node:crypto';

import type {
  DatabaseRepository,
  SandboxSessionRestoreFence,
  SandboxSessionRow,
} from '../database/repository.js';
import { unrefTimer } from '../util/timing.js';

const DEFAULT_RESTORE_LEASE_MS = 120_000;
const DEFAULT_RESTORE_HEARTBEAT_MS = 30_000;

interface Logger {
  warn(msg: string, ...args: unknown[]): void;
}

interface SandboxSessionRestoreLeaseDeps {
  db: Pick<
    DatabaseRepository,
    | 'claimSandboxSessionRestore'
    | 'renewSandboxSessionRestoreLease'
    | 'completeSandboxSessionRestore'
    | 'failSandboxSessionRestore'
  >;
  logger: Logger;
}

export interface SandboxSessionRestoreLease {
  session: SandboxSessionRow;
  fence: SandboxSessionRestoreFence;
  signal: AbortSignal;
  complete(runtime: {
    containerName: string;
    containerId: string;
  }): Promise<SandboxSessionRow | undefined>;
  fail(
    toStatus: 'CHECKPOINTED' | 'TERMINATED',
    error: string,
    options?: { refundAttempt?: boolean },
  ): Promise<SandboxSessionRow | undefined>;
  stop(): Promise<void>;
}

export interface SandboxSessionRestoreLeaseOptions {
  ownerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * Own one renewable, generation-fenced checkpoint restore.
 *
 * The database clock admits and renews ownership. The local deadline only
 * stops this worker promptly when it cannot prove that its lease is still
 * renewable.
 */
export async function acquireSandboxSessionRestoreLease(
  deps: SandboxSessionRestoreLeaseDeps,
  sandboxSessionId: string,
  maxAttempts: number,
  options: SandboxSessionRestoreLeaseOptions = {},
): Promise<SandboxSessionRestoreLease | undefined> {
  const ownerId = options.ownerId ?? randomUUID();
  const leaseMs = options.leaseMs ?? DEFAULT_RESTORE_LEASE_MS;
  const heartbeatMs =
    options.heartbeatMs ?? DEFAULT_RESTORE_HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  if (leaseMs <= 0 || heartbeatMs <= 0 || heartbeatMs >= leaseMs) {
    throw new Error(
      'Sandbox restore heartbeat must be positive and shorter than its lease',
    );
  }

  const claimStartedAt = now();
  const claimed = await deps.db.claimSandboxSessionRestore({
    sandboxSessionId,
    ownerId,
    leaseDurationMs: leaseMs,
    maxAttempts,
  });
  if (
    !claimed
    || claimed.restoreOwnerId !== ownerId
    || claimed.restoreFenceToken < 1
  ) {
    return undefined;
  }

  const fence: SandboxSessionRestoreFence = {
    ownerId,
    fenceToken: claimed.restoreFenceToken,
  };
  const controller = new AbortController();
  let localLeaseDeadline = claimStartedAt + leaseMs;
  let stopped = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalPromise: Promise<void> | undefined;

  const loseLease = (message: string, cause?: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(
      new Error(message, cause === undefined ? undefined : { cause }),
    );
    deps.logger.warn(`[SandboxSessionRestoreLease] ${message}`);
  };

  const armExpiry = (): void => {
    if (stopped || controller.signal.aborted) return;
    if (expiryTimer) clearTimeout(expiryTimer);
    const remainingMs = localLeaseDeadline - now();
    if (remainingMs <= 0) {
      loseLease(`restore lease expired for sandbox session ${sandboxSessionId}`);
      return;
    }
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (now() >= localLeaseDeadline) {
        loseLease(
          `restore lease expired for sandbox session ${sandboxSessionId}`,
        );
      } else {
        armExpiry();
      }
    }, remainingMs);
    unrefTimer(expiryTimer);
  };

  const waitForPendingRenewal = async (): Promise<void> => {
    const pendingRenewal = renewalPromise;
    if (!pendingRenewal || controller.signal.aborted) return;

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      controller.signal.addEventListener('abort', finish, { once: true });
      void pendingRenewal.then(finish, finish);
    });
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    await waitForPendingRenewal();
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
  };

  armExpiry();
  const heartbeat = setInterval(() => {
    if (stopped || renewalPromise || controller.signal.aborted) return;
    const renewalStartedAt = now();
    renewalPromise = deps.db
      .renewSandboxSessionRestoreLease(
        sandboxSessionId,
        fence,
        leaseMs,
      )
      .then((renewed) => {
        if (!renewed) {
          loseLease(
            `lost restore lease for sandbox session ${sandboxSessionId}`,
          );
          return;
        }
        const renewedLeaseDeadline = renewalStartedAt + leaseMs;
        if (now() >= renewedLeaseDeadline) {
          loseLease(
            `restore lease expired for sandbox session ${sandboxSessionId}`,
          );
          return;
        }
        localLeaseDeadline = renewedLeaseDeadline;
        armExpiry();
      })
      .catch((error: unknown) => {
        deps.logger.warn(
          `[SandboxSessionRestoreLease] failed to renew sandbox session ${sandboxSessionId}:`,
          error,
        );
        if (now() >= localLeaseDeadline) {
          loseLease(
            `restore lease expired for sandbox session ${sandboxSessionId}`,
            error,
          );
        }
      })
      .finally(() => {
        renewalPromise = undefined;
      });
  }, heartbeatMs);
  unrefTimer(heartbeat);

  const waitForRenewal = async (): Promise<boolean> => {
    await waitForPendingRenewal();
    return !stopped && !controller.signal.aborted;
  };

  return {
    session: claimed,
    fence,
    signal: controller.signal,
    complete: async (runtime) => {
      if (!await waitForRenewal()) return undefined;
      return deps.db.completeSandboxSessionRestore(
        sandboxSessionId,
        fence,
        runtime,
      );
    },
    fail: async (toStatus, error, options) => {
      if (!await waitForRenewal()) return undefined;
      return deps.db.failSandboxSessionRestore(
        sandboxSessionId,
        fence,
        { toStatus, error, refundAttempt: options?.refundAttempt },
      );
    },
    stop,
  };
}
