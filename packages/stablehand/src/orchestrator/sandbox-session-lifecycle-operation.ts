import { randomUUID } from 'node:crypto';

import type {
  DatabaseRepository,
  SandboxSessionActiveGeneration,
  SandboxSessionLifecycleFence,
  SandboxSessionLifecycleOperation,
} from '../database/repository.js';
import { unrefTimer } from '../util/timing.js';
import type { TurnDeliveryFence } from './turn-delivery-fence.js';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 20_000;

interface Logger {
  warn(msg: string, ...args: unknown[]): void;
}

interface SandboxSessionLifecycleOperationDeps {
  db: Pick<
    DatabaseRepository,
    | 'claimSandboxSessionLifecycleOperation'
    | 'renewSandboxSessionLifecycleOperation'
    | 'markSandboxSessionLifecycleOperationExecuting'
    | 'cancelSandboxSessionLifecycleOperation'
  >;
  logger: Logger;
}

export interface SandboxSessionLifecycleOperationGuard {
  operation: SandboxSessionLifecycleOperation;
  operationId: string;
  phase: 'reserved' | 'draining' | 'executing';
  fence: SandboxSessionLifecycleFence;
  signal: AbortSignal;
  markExecuting(): Promise<boolean>;
  cancel(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface SandboxSessionLifecycleOperationOptions {
  expectedActiveGeneration: SandboxSessionActiveGeneration;
  ownerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  allowedTurnDelivery?: {
    turnId: string;
    fence: TurnDeliveryFence;
    interruptResumeAttemptId?: string;
  };
}

/**
 * Hold one durable lifecycle or runtime-adoption intent.
 *
 * Stopping the heartbeat never clears an unfinished intent. An expired worker
 * may be taken over, but turn admission remains blocked until a reserved
 * operation is safely cancelled or an executing destructive operation
 * completes together with a non-ACTIVE session transition.
 */
export async function acquireSandboxSessionLifecycleOperation(
  deps: SandboxSessionLifecycleOperationDeps,
  sandboxSessionId: string,
  operation: SandboxSessionLifecycleOperation,
  options: SandboxSessionLifecycleOperationOptions,
): Promise<SandboxSessionLifecycleOperationGuard | undefined> {
  const ownerId = options.ownerId ?? randomUUID();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  if (leaseMs <= 0 || heartbeatMs <= 0 || heartbeatMs >= leaseMs) {
    throw new Error(
      'Sandbox lifecycle heartbeat must be positive and shorter than its lease',
    );
  }

  const claimStartedAt = now();
  const claimed = await deps.db.claimSandboxSessionLifecycleOperation({
    sandboxSessionId,
    operation,
    ownerId,
    leaseDurationMs: leaseMs,
    expectedActiveGeneration: options.expectedActiveGeneration,
    ...(options.allowedTurnDelivery
      ? {
          allowedTurnDelivery: {
            turnId: options.allowedTurnDelivery.turnId,
            ownerId: options.allowedTurnDelivery.fence.ownerId,
            fenceToken: options.allowedTurnDelivery.fence.fenceToken,
            ...(options.allowedTurnDelivery.interruptResumeAttemptId
              ? {
                  interruptResumeAttemptId:
                    options.allowedTurnDelivery.interruptResumeAttemptId,
                }
              : {}),
          },
        }
      : {}),
  });
  if (!claimed) {
    return undefined;
  }

  const fence: SandboxSessionLifecycleFence = {
    ownerId: claimed.ownerId,
    fenceToken: claimed.fenceToken,
  };
  const controller = new AbortController();
  let localLeaseDeadline = claimStartedAt + leaseMs;
  let stopped = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalPromise: Promise<void> | undefined;

  const loseLease = (message: string, cause?: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(message, cause === undefined ? undefined : { cause }));
    deps.logger.warn(`[SandboxSessionLifecycleOperation] ${message}`);
  };

  const armExpiry = (): void => {
    if (stopped || controller.signal.aborted) return;
    if (expiryTimer) clearTimeout(expiryTimer);
    const remainingMs = localLeaseDeadline - now();
    if (remainingMs <= 0) {
      loseLease(`lifecycle lease expired for sandbox session ${sandboxSessionId}`);
      return;
    }
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (now() >= localLeaseDeadline) {
        loseLease(`lifecycle lease expired for sandbox session ${sandboxSessionId}`);
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

  const stopHeartbeat = async (): Promise<void> => {
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
    renewalPromise = deps.db.renewSandboxSessionLifecycleOperation(
      sandboxSessionId,
      fence.ownerId,
      fence.fenceToken,
      leaseMs,
    ).then((renewed) => {
      if (!renewed) {
        loseLease(`lost lifecycle lease for sandbox session ${sandboxSessionId}`);
        return;
      }
      const renewedLeaseDeadline = renewalStartedAt + leaseMs;
      if (now() >= renewedLeaseDeadline) {
        loseLease(`lifecycle lease expired for sandbox session ${sandboxSessionId}`);
        return;
      }
      localLeaseDeadline = renewedLeaseDeadline;
      armExpiry();
    }).catch((err: unknown) => {
      deps.logger.warn(
        `[SandboxSessionLifecycleOperation] failed to renew sandbox session ${sandboxSessionId}:`,
        err,
      );
      if (now() >= localLeaseDeadline) {
        loseLease(
          `lifecycle lease expired for sandbox session ${sandboxSessionId}`,
          err,
        );
      }
    }).finally(() => {
      renewalPromise = undefined;
    });
  }, heartbeatMs);
  unrefTimer(heartbeat);

  const waitForRenewal = async (): Promise<boolean> => {
    await waitForPendingRenewal();
    return !stopped && !controller.signal.aborted;
  };

  return {
    operation: claimed.operation,
    operationId: claimed.operationId,
    phase: claimed.phase === 'executing'
      ? 'executing'
      : claimed.phase === 'draining'
        ? 'draining'
        : 'reserved',
    fence,
    signal: controller.signal,
    markExecuting: async () => {
      if (!await waitForRenewal()) return false;
      const executing = await deps.db.markSandboxSessionLifecycleOperationExecuting(
        sandboxSessionId,
        fence.ownerId,
        fence.fenceToken,
      );
      if (!executing) {
        deps.logger.warn(
          `[SandboxSessionLifecycleOperation] ` +
          `could not enter lifecycle execution for sandbox session ${sandboxSessionId}`,
        );
      }
      return executing;
    },
    cancel: async () => {
      if (!await waitForRenewal()) {
        await stopHeartbeat();
        return false;
      }
      const cancelled = await deps.db.cancelSandboxSessionLifecycleOperation(
        sandboxSessionId,
        fence.ownerId,
        fence.fenceToken,
      );
      await stopHeartbeat();
      return cancelled;
    },
    stop: stopHeartbeat,
  };
}
