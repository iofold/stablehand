import {
  DEFAULT_CONTAINER_STARTUP_GRACE_MS,
  STARTUP_GRACE_MS_LABEL,
  type ContainerInfo,
  type SandboxContainerManager,
} from '../sandbox/container-manager.js';
import type {
  DatabaseRepository,
  SandboxSessionActiveGeneration,
  SandboxSessionRow,
} from '../database/repository.js';
import { retryWithBackoff } from '@ctxmill/sandbox-daemon';
import { hasStatusCode } from '../util/status-code-error.js';
import { parsePositiveMs, unrefTimer } from '../util/timing.js';
import {
  type HarnessGrpcClient,
  waitForContainerReady,
} from './session-manager/grpc-session-client.js';
import type {
  SessionReconnectionRegistration,
} from './session-manager/ports.js';
import { sandboxGrpcBaseUrl } from './session-manager/sandbox-endpoint.js';
import {
  StaleTransitionError,
  type SessionStatusCoordinator,
} from './session-manager/session-status-coordinator.js';
import type { SessionStatus } from './session-manager/types.js';
import { isAliveContainerStatus } from '../sandbox/runtime/status.js';
import { stopAndRemoveContainer } from './container-cleanup.js';
import {
  acquireSandboxSessionLifecycleOperation,
  type SandboxSessionLifecycleOperationGuard,
} from './sandbox-session-lifecycle-operation.js';

const TAG = '[LifecyclePolicy]';
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LIFECYCLE_RECOVERY_INTERVAL_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const MAX_IDLE_CHECKPOINT_FAILURES = 3;
const MAX_CONCURRENT_IDLE_CHECKPOINTS = 3;

export type PauseState = 'none' | 'promoting';

export interface IdleCallbacks {
  onCheckpoint: (sessionId: string) => Promise<void>;
  onContainerGone?: (sessionId: string) => Promise<void>;
}

export interface PauseEntry {
  containerId: string;
  state: PauseState;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleCallbacks?: IdleCallbacks;
  idleFailureCount?: number;
}

type ManagedContainerWithLabels = ContainerInfo & { labels: Record<string, string> };

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface ReconciliationCallbacks {
  onSessionReconnected: (
    session: SandboxSessionRow,
    grpcClient?: HarnessGrpcClient,
  ) => SessionReconnectionRegistration;
  onSessionEvicted: (sessionId: string, conversationId: string) => void | Promise<void>;
  reconcileExpiredSandboxSessionRestore: (
    session: SandboxSessionRow,
  ) => Promise<'CHECKPOINTED' | 'TERMINATED' | undefined>;
}

export interface ContainerLifecyclePolicyDeps {
  containerManager: SandboxContainerManager;
  db: DatabaseRepository;
  logger: Logger;
  config: {
    reconciliationIntervalMs?: number;
    idleTimeoutMs?: number;
  };
  reconciliationCallbacks: ReconciliationCallbacks;
  statusCoordinator: SessionStatusCoordinator;
}

export interface LifecycleRuntimeConfigUpdate {
  reconciliationIntervalMs?: number;
  idleTimeoutMs?: number;
}

export interface ActiveSandboxReadbackOptions {
  shouldDefer?: (session: SandboxSessionRow) => boolean;
}

type ContainerCleanupDecision = 'kill' | 'kill-after-checkpoint' | 'skip';

function clearTimeoutSafe(timer?: ReturnType<typeof setTimeout>): void {
  if (timer) {
    clearTimeout(timer);
  }
}

function getStartupGraceMs(labels: Record<string, string>): number {
  return parsePositiveMs(labels[STARTUP_GRACE_MS_LABEL]) ?? DEFAULT_CONTAINER_STARTUP_GRACE_MS;
}

function getStartedAtMs(labels: Record<string, string>): number | undefined {
  const rawStartedAt = labels['ctxmill.started-at'];
  if (!rawStartedAt) return undefined;
  const parsed = new Date(rawStartedAt).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLiveSandboxSessionStatus(status: string): boolean {
  return status === 'ACTIVE' || status === 'RESTORING';
}

export class ContainerLifecyclePolicy {
  private readonly containerManager: SandboxContainerManager;
  private readonly db: DatabaseRepository;
  private readonly logger: Logger;
  private readonly reconciliationCallbacks: ReconciliationCallbacks;
  private readonly statusCoordinator: SessionStatusCoordinator;
  private reconciliationIntervalMs: number;
  private idleTimeoutMs: number;
  private readonly entries = new Map<string, PauseEntry>();
  private readonly sessionConversationIds = new Map<string, string>();
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationRunning = false;
  private activeIdleCheckpoints = 0;
  private lifecycleRecoveryRunning = false;
  private readonly removingContainers = new Set<string>();

  constructor(deps: ContainerLifecyclePolicyDeps) {
    this.containerManager = deps.containerManager;
    this.db = deps.db;
    this.logger = deps.logger;
    this.statusCoordinator = deps.statusCoordinator;
    this.reconciliationCallbacks = deps.reconciliationCallbacks;
    this.reconciliationIntervalMs = deps.config.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.idleTimeoutMs = deps.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    await this.reconcileOnStartup();

    if (this.reconciliationTimer) {
      this.logger.warn(`${TAG} reconciliation timer already running`);
      return;
    }

    this.startReconciliationTimer();
    this.startLifecycleRecoveryTimer();

    this.logger.info(
      `${TAG} started periodic reconciliation every ${this.reconciliationIntervalMs / 1000}s`,
    );
  }

  stop(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    if (this.lifecycleRecoveryTimer) {
      clearInterval(this.lifecycleRecoveryTimer);
      this.lifecycleRecoveryTimer = null;
    }
    this.cleanupAll();
    this.logger.info(`${TAG} stopped`);
  }

  updateConfig(update: LifecycleRuntimeConfigUpdate): void {
    const nextIdleTimeoutMs = update.idleTimeoutMs;
    const nextReconciliationIntervalMs = update.reconciliationIntervalMs;

    if (
      nextIdleTimeoutMs !== undefined
      && Number.isFinite(nextIdleTimeoutMs)
      && nextIdleTimeoutMs > 0
      && nextIdleTimeoutMs !== this.idleTimeoutMs
    ) {
      this.idleTimeoutMs = nextIdleTimeoutMs;
      this.rearmIdleTimers();
      this.logger.info(`${TAG} updated idle timeout to ${this.idleTimeoutMs}ms`);
    }

    if (
      nextReconciliationIntervalMs !== undefined
      && Number.isFinite(nextReconciliationIntervalMs)
      && nextReconciliationIntervalMs > 0
      && nextReconciliationIntervalMs !== this.reconciliationIntervalMs
    ) {
      this.reconciliationIntervalMs = nextReconciliationIntervalMs;
      if (this.reconciliationTimer) {
        clearInterval(this.reconciliationTimer);
        this.reconciliationTimer = null;
        this.startReconciliationTimer();
      }
      this.logger.info(`${TAG} updated reconciliation interval to ${this.reconciliationIntervalMs}ms`);
    }
  }

  private startReconciliationTimer(): void {
    this.reconciliationTimer = setInterval(() => {
      void this.runReconciliation().catch((err) => {
        this.logger.error(`${TAG} periodic reconciliation error:`, err);
      });
    }, this.reconciliationIntervalMs);
    unrefTimer(this.reconciliationTimer);
  }

  private startLifecycleRecoveryTimer(): void {
    this.lifecycleRecoveryTimer = setInterval(() => {
      void this.runLifecycleRecovery().catch((err) => {
        this.logger.error(`${TAG} lifecycle recovery error:`, err);
      });
    }, DEFAULT_LIFECYCLE_RECOVERY_INTERVAL_MS);
    unrefTimer(this.lifecycleRecoveryTimer);
  }

  private async runLifecycleRecovery(): Promise<void> {
    if (this.lifecycleRecoveryRunning) {
      return;
    }
    this.lifecycleRecoveryRunning = true;
    try {
      await this.reconcileExpiredLifecycleOperations();
    } finally {
      this.lifecycleRecoveryRunning = false;
    }
  }

  private clearEntryTimers(entry: PauseEntry): void {
    clearTimeoutSafe(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private shouldDeferUnownedStartupContainer(
    container: ManagedContainerWithLabels,
    sessionId: string | undefined,
  ): boolean {
    if (!sessionId || !isAliveContainerStatus(container.status)) {
      return false;
    }

    const startedAtMs = getStartedAtMs(container.labels);
    if (startedAtMs === undefined) {
      return false;
    }

    const startupGraceMs = getStartupGraceMs(container.labels);
    const ageMs = Date.now() - startedAtMs;
    if (ageMs > startupGraceMs) {
      return false;
    }

    const releasedSlot = this.containerManager.releaseContainerSlot?.(container.containerId) ?? false;
    this.logger.debug(
      `${TAG} skipping orphan cleanup for recent startup container ${container.containerName} (${container.containerId}); session=${sessionId}, ageMs=${ageMs}, graceMs=${startupGraceMs}, releasedSlot=${releasedSlot}`,
    );
    return true;
  }

  getState(sessionId: string): PauseState {
    return this.entries.get(sessionId)?.state ?? 'none';
  }

  private armIdleTimer(sessionId: string, entry: PauseEntry, delayMs = this.idleTimeoutMs): void {
    clearTimeoutSafe(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.executeIdleCheckpoint(sessionId).catch((err) => {
        this.logger.warn(`${TAG} idle checkpoint failed for session ${sessionId}:`, err);
      });
    }, delayMs);
    unrefTimer(entry.idleTimer);
  }

  /**
   * ctx-bukh: idleness must survive restarts. Timers are process-local, but
   * sandbox_sessions.last_activity_at is durable — on adoption/reconnect the
   * deadline resumes from it instead of resetting to a fresh full window
   * (which let crash-loops faster than the timeout suspend nothing, ever).
   * Jitter breaks the post-restart lockstep herd.
   */
  private adjustIdleTimerFromLastActivity(sessionId: string, entry: PauseEntry): void {
    void (async () => {
      try {
        const session = await this.db.getSandboxSession(sessionId);
        const lastActivityAt = session?.lastActivityAt;
        if (typeof lastActivityAt !== 'number' || lastActivityAt <= 0) return;
        const current = this.entries.get(sessionId);
        if (current !== entry || entry.state !== 'none' || !entry.idleCallbacks) return;
        const elapsed = Date.now() - lastActivityAt;
        if (elapsed <= 0) return;
        const remaining = Math.max(
          5_000 + Math.floor(Math.random() * 10_000),
          this.idleTimeoutMs - elapsed,
        );
        if (remaining >= this.idleTimeoutMs) return;
        this.armIdleTimer(sessionId, entry, remaining);
        this.logger.debug(
          `${TAG} resumed idle deadline for session ${sessionId}: ${remaining}ms remaining of ${this.idleTimeoutMs}ms`,
        );
      } catch (err) {
        this.logger.warn(`${TAG} failed to resume idle deadline for session ${sessionId}:`, err);
      }
    })();
  }

  private rearmIdleTimers(): void {
    for (const [sessionId, entry] of this.entries) {
      if (!entry.idleTimer || !entry.idleCallbacks || entry.state !== 'none') {
        continue;
      }
      this.armIdleTimer(sessionId, entry);
      this.entries.set(sessionId, entry);
      this.logger.debug(`${TAG} re-armed idle timeout for session ${sessionId} in ${this.idleTimeoutMs}ms`);
    }
  }

  scheduleIdleTimeout(
    sessionId: string,
    containerId: string,
    callbacks: IdleCallbacks,
    options?: { resumeFromLastActivity?: boolean },
  ): void {
    void this.cancelIdleTimeout(sessionId).catch((err) => {
      this.logger.warn(`${TAG} cancelIdleTimeout failed during reschedule for ${sessionId}:`, err);
    });

    const entry = this.entries.get(sessionId) ?? {
      containerId,
      state: 'none',
    };

    clearTimeoutSafe(entry.idleTimer);
    entry.containerId = containerId;
    entry.state = 'none';
    entry.idleCallbacks = callbacks;
    entry.idleFailureCount = 0;
    this.armIdleTimer(sessionId, entry);

    this.entries.set(sessionId, entry);
    this.logger.debug(`${TAG} scheduled idle timeout for session ${sessionId} in ${this.idleTimeoutMs}ms`);
    if (options?.resumeFromLastActivity) {
      this.adjustIdleTimerFromLastActivity(sessionId, entry);
    }
  }

  async cancelIdleTimeout(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }

    this.clearEntryTimers(entry);
    entry.idleCallbacks = undefined;
    entry.state = 'none';
    this.maybeDeleteEntry(sessionId, entry);
    this.logger.debug(`${TAG} cancelled idle timeout for session ${sessionId}`);
  }

  cleanup(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }

    this.clearEntryTimers(entry);
    this.entries.delete(sessionId);
    this.logger.debug(`${TAG} cleaned up lifecycle entry for session ${sessionId}`);
  }

  cleanupAll(): void {
    for (const [sessionId, entry] of this.entries) {
      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
    }
  }

  private maybeDeleteEntry(sessionId: string, entry: PauseEntry): void {
    const hasTimers = Boolean(entry.idleTimer);

    if (!hasTimers && entry.state === 'none' && !entry.idleCallbacks) {
      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
      return;
    }

    this.entries.set(sessionId, entry);
  }

  private rescheduleIdleCheckpointRetry(sessionId: string, entry: PauseEntry, callbacks: IdleCallbacks): void {
    const failureCount = (entry.idleFailureCount ?? 0) + 1;
    entry.idleFailureCount = failureCount;
    entry.state = 'none';
    entry.idleCallbacks = callbacks;

    if (failureCount > MAX_IDLE_CHECKPOINT_FAILURES) {
      this.logger.error(
        `${TAG} idle checkpoint retry limit reached for session ${sessionId}; idle monitoring disabled until activity reschedules it`,
      );
      this.clearEntryTimers(entry);
      entry.idleCallbacks = undefined;
      this.entries.delete(sessionId);
      return;
    }

    this.armIdleTimer(sessionId, entry);
    this.entries.set(sessionId, entry);
    this.logger.warn(
      `${TAG} re-armed idle checkpoint for session ${sessionId} after transient failure ` +
      `(attempt ${failureCount}/${MAX_IDLE_CHECKPOINT_FAILURES})`,
    );
  }

  private async executeIdleCheckpoint(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }

    entry.idleTimer = undefined;

    if (entry.state !== 'none') {
      this.entries.set(sessionId, entry);
      return;
    }

    const callbacks = entry.idleCallbacks;
    if (!callbacks) {
      this.maybeDeleteEntry(sessionId, entry);
      return;
    }

    let hasLiveDelivery: boolean;
    try {
      hasLiveDelivery = await this.db.hasLiveTurnDeliveryForSandboxSession(sessionId)
        // ctx-z5k0 full idle veto: queued work for this session's
        // conversation means it is not idle — suspending would be
        // suspend/restore whiplash the moment the dispatcher arrives.
        || await this.db.hasQueuedTurnsForSandboxSession(sessionId);
    } catch (err) {
      if (this.entries.get(sessionId) !== entry || entry.idleCallbacks !== callbacks) {
        return;
      }
      this.logger.error(
        `${TAG} failed to verify turn delivery before idle checkpoint for session ${sessionId}:`,
        err,
      );
      this.rescheduleIdleCheckpointRetry(sessionId, entry, callbacks);
      return;
    }

    if (
      this.entries.get(sessionId) !== entry
      || entry.idleCallbacks !== callbacks
      || entry.state !== 'none'
    ) {
      return;
    }

    if (hasLiveDelivery) {
      entry.idleFailureCount = 0;
      this.armIdleTimer(sessionId, entry);
      this.entries.set(sessionId, entry);
      this.logger.debug(
        `${TAG} deferred idle checkpoint for session ${sessionId}; ` +
        'a turn has a live delivery lease',
      );
      return;
    }

    // ctx-bukh: bound simultaneous workspace captures. A synchronized idle
    // wave (batch completion, post-restart) must drain in bounded batches,
    // not as N concurrent tar captures. Staggered re-arm, not a failure.
    if (this.activeIdleCheckpoints >= MAX_CONCURRENT_IDLE_CHECKPOINTS) {
      this.armIdleTimer(sessionId, entry, 10_000 + Math.floor(Math.random() * 10_000));
      this.entries.set(sessionId, entry);
      this.logger.debug(
        `${TAG} deferred idle checkpoint for session ${sessionId}; ${this.activeIdleCheckpoints} captures already running`,
      );
      return;
    }

    entry.state = 'promoting';
    this.entries.set(sessionId, entry);
    this.logger.debug(`${TAG} idle timeout reached for session ${sessionId}, checkpointing directly`);

    this.activeIdleCheckpoints += 1;
    try {
      await retryWithBackoff(() => callbacks.onCheckpoint(sessionId), {
        delays: [1_000, 2_000],
        shouldRetry: (err) => !hasStatusCode(err, 404),
        onRetry: (err, attempt, delayMs) => {
          this.logger.warn(
            `${TAG} retrying idle checkpoint for session ${sessionId} after attempt ${attempt + 1} in ${delayMs}ms:`,
            err,
          );
        },
      });

      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
      this.logger.debug(`${TAG} idle session ${sessionId} checkpointed successfully`);
    } catch (err) {
      if (hasStatusCode(err, 404)) {
        this.logger.warn(`${TAG} container missing during idle checkpoint for session ${sessionId}`);
        try {
          await callbacks.onContainerGone?.(sessionId);
        } catch (goneErr) {
          this.logger.warn(`${TAG} onContainerGone failed for session ${sessionId}:`, goneErr);
        }
        this.clearEntryTimers(entry);
        entry.state = 'none';
        entry.idleCallbacks = undefined;
        this.entries.delete(sessionId);
      } else {
        this.logger.error(`${TAG} failed to checkpoint idle session ${sessionId}:`, err);
        this.rescheduleIdleCheckpointRetry(sessionId, entry, callbacks);
      }
    } finally {
      this.activeIdleCheckpoints -= 1;
    }
  }

  private async reconcileOnStartup(): Promise<void> {
    this.logger.info(`${TAG} reconciling sandbox sessions on startup`);
    await this.runLifecycleRecovery();

    const [
      dbSessions,
      restoringSessions,
      expiredRestores,
      liveContainers,
    ] = await Promise.all([
      this.db.getActiveSandboxSessions(),
      this.db.getRestoringSandboxSessions(),
      this.db.getExpiredSandboxSessionRestores(),
      this.containerManager.listManagedContainersWithLabels(),
    ]);

    // Reconcile only the exact expired restore generations observed by the
    // database. Container liveness cannot substitute for a durable owner
    // lease: a process may crash after starting its runtime.
    const {
      restoringReconciled,
      restoringTerminated,
      preservedRestoringSessionIds,
    } =
      await this.reconcileExpiredSandboxSessionRestores(
        restoringSessions,
        expiredRestores,
      );
    if (restoringSessions.length > 0) {
      this.logger.info(
        `${TAG} expired restore reconciliation: checkpointed=${restoringReconciled}, terminated=${restoringTerminated}`,
      );
    }

    const containerByName = new Map(liveContainers.map((container) => [container.containerName, container]));
    const containerById = new Map(liveContainers.map((container) => [container.containerId, container]));
    const knownContainerIds = new Set(
      liveContainers
        .filter((container) => {
          const sessionId = container.labels['ctxmill.sandbox-session-id'];
          return sessionId !== undefined
            && preservedRestoringSessionIds.has(sessionId);
        })
        .map((container) => container.containerId),
    );
    let reconnected = 0;
    let markedCheckpointed = 0;
    let deleted = 0;
    let deadCleaned = 0;
    let orphansCleaned = 0;

    for (const session of dbSessions) {
      this.sessionConversationIds.set(session.id, session.conversationId);
      const container = this.findLiveContainerForSession(session, liveContainers, containerById, containerByName);
      if (container) {
        knownContainerIds.add(container.containerId);
      }
      const alive = container !== undefined && isAliveContainerStatus(container.status);
      const hasUnfinishedLifecycleOperation =
        await this.db.hasUnfinishedSandboxSessionLifecycleOperation(session.id);
      const hasLiveDelivery = await this.db.hasLiveTurnDeliveryForSandboxSession(session.id);

      if (hasUnfinishedLifecycleOperation) {
        this.logger.info(
          `${TAG} session ${session.id}: deferring startup adoption while ` +
          'a sandbox lifecycle operation is unfinished',
        );
        continue;
      }

      if (hasLiveDelivery) {
        this.logger.info(
          `${TAG} session ${session.id}: deferring startup adoption while ` +
          'a turn has a live delivery lease',
        );
        continue;
      }

      if (!alive) {
        const resultingStatus = await this.demoteDeadSession(
          session.id,
          session.conversationId,
          session.status as SessionStatus,
          {
            restoreFenceToken: session.restoreFenceToken,
            containerId: session.containerId,
          },
        );
        if (!resultingStatus) {
          this.logger.info(
            `${TAG} session ${session.id}: deferring dead-session demotion; ` +
            'lifecycle ownership was not available',
          );
          continue;
        }
        if (resultingStatus === 'CHECKPOINTED') {
          markedCheckpointed++;
        } else {
          deleted++;
        }
        if (container && await this.cleanupManagedContainer(
          container,
          resultingStatus === 'CHECKPOINTED'
            ? 'dead container retained after checkpoint promotion'
            : 'dead container retained after session termination',
        )) {
          deadCleaned++;
        }
        continue;
      }

      if (session.status === 'ACTIVE' && container.status !== 'paused') {
        const reconnectedSession = await this.syncContainerBinding(session, container);
        if (!reconnectedSession) {
          continue;
        }

        const adoption = await acquireSandboxSessionLifecycleOperation(
          { db: this.db, logger: this.logger },
          session.id,
          'adopt',
          {
            expectedActiveGeneration: {
              restoreFenceToken: reconnectedSession.restoreFenceToken,
              containerId: reconnectedSession.containerId,
            },
          },
        );
        if (!adoption || adoption.operation !== 'adopt') {
          await adoption?.stop();
          this.logger.info(
            `${TAG} session ${session.id}: deferring startup adoption; ` +
            'durable adoption ownership was not available',
          );
          continue;
        }

        let reconnectionRegistration:
          SessionReconnectionRegistration | undefined;
        let registered = false;
        try {
          adoption.signal.throwIfAborted();
          this.logger.info(`${TAG} session ${session.id}: container running, reconnecting gRPC client`);
          const baseUrl = sandboxGrpcBaseUrl(container);
          const runtimeInstanceToken =
            await this.containerManager.getRuntimeInstanceToken(
              container.containerId,
            );
          adoption.signal.throwIfAborted();
          if (!runtimeInstanceToken) {
            this.logger.warn(
              `${TAG} session ${session.id}: skipping startup adoption; ` +
              'the live container has no runtime instance token',
            );
            continue;
          }
          const { grpcClient } = await waitForContainerReady(baseUrl, {
            runtimeInstanceToken,
            signal: adoption.signal,
          });
          adoption.signal.throwIfAborted();
          const currentSession = await this.db.getSandboxSession(session.id);
          adoption.signal.throwIfAborted();
          if (
            !currentSession
            || currentSession.status !== 'ACTIVE'
            || currentSession.restoreFenceToken
              !== reconnectedSession.restoreFenceToken
            || currentSession.containerId !== reconnectedSession.containerId
          ) {
            this.logger.info(
              `${TAG} session ${session.id}: skipping stale startup adoption; ` +
              'the active generation changed while waiting for gRPC readiness',
            );
            continue;
          }
          // The generation-tagged cache is a revocable registration. Durable
          // admission remains blocked until cancellation is confirmed; if
          // ownership was lost during a stalled callback, the exact installed
          // record and its idle monitor are rolled back below.
          reconnectionRegistration =
            this.reconciliationCallbacks.onSessionReconnected(
              currentSession,
              grpcClient,
            );
          registered = true;
        } finally {
          let released: boolean;
          try {
            released = await this.releaseStartupAdoption(
              adoption,
              reconnectedSession,
              reconnectionRegistration,
            );

            if (!released) {
              await reconnectionRegistration?.revoke();
              if (registered) {
                this.logger.warn(
                  `${TAG} session ${session.id}: rolled back startup adoption after ownership loss`,
                );
              } else {
                this.logger.warn(
                  `${TAG} session ${session.id}: could not release startup adoption ownership`,
                );
              }
            } else if (registered) {
              reconnected++;
            }
          } finally {
            await adoption.stop();
          }
        }
      }
    }

    for (const container of liveContainers) {
      if (knownContainerIds.has(container.containerId)) {
        continue;
      }

      if (this.removingContainers.has(container.containerId)) continue;

      const sessionId = container.labels['ctxmill.sandbox-session-id'];
      if (sessionId && await this.hasPersistedLiveSandboxSession(sessionId)) {
        knownContainerIds.add(container.containerId);
        continue;
      }

      if (this.shouldDeferUnownedStartupContainer(container, sessionId)) {
        continue;
      }

      if (await this.cleanupManagedContainer(
        container,
        'orphan container without a persisted session',
        5,
      )) {
        orphansCleaned++;
      }
    }

    try {
      const cleaned = await this.db.cleanupToolDedup()
      if (cleaned > 0) {
        this.logger.info(`${TAG} cleaned up ${cleaned} stale tool dedup entries`);
      }
    } catch (err) {
      this.logger.warn(`${TAG} tool dedup cleanup failed:`, err);
    }

    this.logger.info(
      `${TAG} reconciliation complete: reconnected=${reconnected}, markedCheckpointed=${markedCheckpointed}, deleted=${deleted}, deadCleaned=${deadCleaned}, orphansCleaned=${orphansCleaned}`,
    );
  }

  private async releaseStartupAdoption(
    adoption: SandboxSessionLifecycleOperationGuard,
    expectedSession: SandboxSessionRow,
    registration: SessionReconnectionRegistration | undefined,
  ): Promise<boolean> {
    try {
      return await adoption.cancel();
    } catch (error) {
      // Cancellation may have committed even when its response was lost.
      // Preserve the only idle monitor only after authoritative readback
      // proves the same generation is ACTIVE and no durable barrier remains.
      try {
        const [
          sessionAfterCancellation,
          hasUnfinishedLifecycleOperation,
        ] = await Promise.all([
          this.db.getSandboxSession(expectedSession.id),
          this.db.hasUnfinishedSandboxSessionLifecycleOperation(
            expectedSession.id,
          ),
        ]);
        const released = Boolean(
          sessionAfterCancellation?.status === 'ACTIVE'
          && sessionAfterCancellation.restoreFenceToken
            === expectedSession.restoreFenceToken
          && sessionAfterCancellation.containerId
            === expectedSession.containerId
          && !hasUnfinishedLifecycleOperation
        );
        this.logger.warn(
          released
            ? `${TAG} session ${expectedSession.id}: adoption cancellation response was lost; authoritative readback confirmed release`
            : `${TAG} session ${expectedSession.id}: adoption cancellation failed and authoritative readback did not confirm release`,
          error,
        );
        return released;
      } catch (readbackError) {
        await registration?.revoke();
        this.logger.error(
          `${TAG} session ${expectedSession.id}: adoption cancellation readback failed`,
          readbackError,
        );
        throw new Error(
          `Could not classify startup adoption cancellation for sandbox session ${expectedSession.id}`,
          { cause: readbackError },
        );
      }
    }
  }

  private async syncContainerBinding(
    session: SandboxSessionRow,
    container: ContainerInfo,
  ): Promise<SandboxSessionRow | undefined> {
    if (session.containerName === container.containerName && session.containerId === container.containerId) {
      return session;
    }

    try {
      await this.statusCoordinator.transition({
        sessionId: session.id,
        fromStatus: session.status as SessionStatus,
        toStatus: session.status as SessionStatus,
        extra: {
          containerName: container.containerName,
          containerId: container.containerId,
        },
        expectedActiveGeneration: session.status === 'ACTIVE'
          ? {
              restoreFenceToken: session.restoreFenceToken,
              containerId: session.containerId,
            }
          : undefined,
      });
    } catch (error) {
      if (!(error instanceof StaleTransitionError)) {
        throw error;
      }
      this.logger.info(
        `${TAG} session ${session.id}: skipping stale container binding repair; ` +
        'the persisted generation changed',
      );
      return undefined;
    }
    return {
      ...session,
      containerName: container.containerName,
      containerId: container.containerId,
    };
  }

  private findLiveContainerForSession(
    session: SandboxSessionRow,
    liveContainers: Array<ContainerInfo & { labels: Record<string, string> }>,
    containerById: Map<string, ContainerInfo & { labels: Record<string, string> }>,
    containerByName: Map<string, ContainerInfo & { labels: Record<string, string> }>,
  ): (ContainerInfo & { labels: Record<string, string> }) | undefined {
    if (session.containerId) {
      const byId = containerById.get(session.containerId);
      if (byId) return byId;
    }

    if (session.containerName) {
      const byName = containerByName.get(session.containerName);
      if (byName) return byName;
    }

    return liveContainers.find((container) => {
      return container.labels['ctxmill.sandbox-session-id'] === session.id;
    });
  }

  async getActiveSandboxSessionsForReadback(
    options: ActiveSandboxReadbackOptions = {},
  ): Promise<SandboxSessionRow[]> {
    const [dbSessions, liveContainers] = await Promise.all([
      this.db.getActiveSandboxSessions(),
      this.containerManager.listManagedContainersWithLabels() as Promise<ManagedContainerWithLabels[]>,
    ]);
    const containerByName = new Map(liveContainers.map((container) => [container.containerName, container]));
    const containerById = new Map(liveContainers.map((container) => [container.containerId, container]));
    const activeRows: SandboxSessionRow[] = [];

    for (const session of dbSessions) {
      this.sessionConversationIds.set(session.id, session.conversationId);
      const container = this.findLiveContainerForSession(session, liveContainers, containerById, containerByName);
      const alive = container !== undefined && isAliveContainerStatus(container.status);

      if (alive) {
        const syncedSession = await this.syncContainerBinding(session, container);
        if (syncedSession) {
          activeRows.push(syncedSession);
        } else {
          const currentSession = await this.db.getSandboxSession(session.id);
          if (currentSession?.status === 'ACTIVE') {
            activeRows.push(currentSession);
          }
        }
        continue;
      }

      if (options.shouldDefer?.(session)) {
        activeRows.push(session);
        continue;
      }

      const hasLiveDelivery = await this.db.hasLiveTurnDeliveryForSandboxSession(session.id);
      if (hasLiveDelivery) {
        activeRows.push(session);
        this.logger.debug(
          `${TAG} readback: preserving session ${session.id}; ` +
          'a turn has a live delivery lease',
        );
        continue;
      }

      const resultingStatus = await this.demoteDeadSession(
        session.id,
        session.conversationId,
        session.status as SessionStatus,
        {
          restoreFenceToken: session.restoreFenceToken,
          containerId: session.containerId,
        },
        { afterTransition: () => this.releaseMissingContainerSlot(session) },
      );
      if (!resultingStatus) {
        activeRows.push(session);
        this.logger.debug(
          `${TAG} readback: preserving session ${session.id}; ` +
          'lifecycle ownership was not available',
        );
        continue;
      }
      this.logger.info(
        resultingStatus === 'CHECKPOINTED'
          ? `${TAG} readback: session ${session.id} container gone, checkpoint exists -> CHECKPOINTED`
          : `${TAG} readback: session ${session.id} container gone, no checkpoint -> TERMINATED`,
      );
    }

    return activeRows;
  }

  private async runReconciliation(): Promise<void> {
    if (this.reconciliationRunning) {
      this.logger.debug(`${TAG} reconciliation already in progress; skipping overlapping run`);
      return;
    }

    this.reconciliationRunning = true;

    try {
      await this.runLifecycleRecovery();
      const [
        dbSessions,
        restoringSessions,
        expiredRestores,
        managedContainers,
      ] = await Promise.all([
        this.db.getActiveSandboxSessions(),
        this.db.getRestoringSandboxSessions(),
        this.db.getExpiredSandboxSessionRestores(),
        this.containerManager.listManagedContainersWithLabels() as Promise<ManagedContainerWithLabels[]>,
      ]);

      const { preservedRestoringSessionIds } =
        await this.reconcileExpiredSandboxSessionRestores(
          restoringSessions,
          expiredRestores,
        );

      for (const session of dbSessions) {
        this.sessionConversationIds.set(session.id, session.conversationId);
      }

      const liveSessionIds = new Set([
        ...dbSessions.map((session) => session.id),
        ...preservedRestoringSessionIds,
      ]);
      const cleanupReasons = new Map<string, string>();
      const managedContainerIds = new Set(managedContainers.map((container) => container.containerId));
      let terminated = 0;
      let checkpointed = 0;
      let cleaned = 0;

      for (const session of dbSessions) {
        const containerId = session.containerId;
        if (!containerId) {
          continue;
        }

        const alive = await this.containerManager.isContainerAlive(containerId);
        if (alive) {
          continue;
        }

        const decision = await this.shouldKillContainer(containerId, session.id);
        if (decision === 'kill') {
          if (managedContainerIds.has(containerId)) {
            cleanupReasons.set(containerId, 'session container dead with no checkpoint');
          } else {
            await this.releaseMissingContainerSlot(session);
          }
          terminated++;
        } else if (decision === 'kill-after-checkpoint') {
          if (managedContainerIds.has(containerId)) {
            cleanupReasons.set(containerId, 'session container dead after checkpoint promotion');
          } else {
            await this.releaseMissingContainerSlot(session);
          }
          checkpointed++;
        }
      }

      for (const container of managedContainers) {
        const sessionId = container.labels['ctxmill.sandbox-session-id'];
        const timeoutSec = Number.parseInt(container.labels['ctxmill.timeout'] ?? '600', 10);
        const startedAtRaw = container.labels['ctxmill.started-at'];
        const startedAtMs = startedAtRaw ? new Date(startedAtRaw).getTime() : Number.NaN;
        const isExpired = Number.isFinite(startedAtMs)
          && timeoutSec > 0
          && (Date.now() - startedAtMs) / 1000 > timeoutSec;
        let hasLiveSession = sessionId !== undefined && liveSessionIds.has(sessionId);
        if (
          !hasLiveSession
          && sessionId
          && await this.hasPersistedLiveSandboxSession(sessionId)
        ) {
          hasLiveSession = true;
          liveSessionIds.add(sessionId);
        }
        if (
          !cleanupReasons.has(container.containerId)
          && !hasLiveSession
          && this.shouldDeferUnownedStartupContainer(container, sessionId)
        ) {
          continue;
        }
        const shouldReview = cleanupReasons.has(container.containerId) || !hasLiveSession || isExpired;

        if (!shouldReview) {
          continue;
        }

        const decision = cleanupReasons.has(container.containerId) || !hasLiveSession
          ? 'kill'
          : await this.shouldKillContainer(container.containerId, sessionId);

        if (decision !== 'kill') {
          continue;
        }

        let reason = cleanupReasons.get(container.containerId) ?? 'container eligible for cleanup';
        if (!cleanupReasons.has(container.containerId) && !hasLiveSession && sessionId) {
          reason = 'no matching live session in DB';
        } else if (!cleanupReasons.has(container.containerId) && !hasLiveSession && !sessionId) {
          reason = 'container has no associated session';
        } else if (!cleanupReasons.has(container.containerId) && isExpired) {
          reason = 'container exceeded timeout';
        }

        if (await this.cleanupManagedContainer(container, reason)) {
          cleaned++;
        }
      }

      if (terminated > 0 || checkpointed > 0 || cleaned > 0) {
        this.logger.info(
          `${TAG} reconciliation complete: terminated=${terminated}, checkpointed=${checkpointed}, cleaned=${cleaned}`,
        );
      }
    } finally {
      this.reconciliationRunning = false;
    }
  }

  private async reconcileExpiredSandboxSessionRestores(
    sessions: SandboxSessionRow[],
    expiredRestores: SandboxSessionRow[],
  ): Promise<{
    restoringReconciled: number;
    restoringTerminated: number;
    preservedRestoringSessionIds: ReadonlySet<string>;
  }> {
    let restoringReconciled = 0;
    let restoringTerminated = 0;
    const preservedRestoringSessionIds = new Set<string>();
    const expiredFenceBySessionId = new Map(
      expiredRestores.map((session) => [
        session.id,
        session.restoreFenceToken,
      ]),
    );
    for (const session of sessions) {
      this.sessionConversationIds.set(session.id, session.conversationId);
      if (
        expiredFenceBySessionId.get(session.id)
          !== session.restoreFenceToken
      ) {
        preservedRestoringSessionIds.add(session.id);
        this.logger.debug(
          `${TAG} preserving leased restore generation ${session.restoreFenceToken} for session ${session.id}`,
        );
        continue;
      }

      try {
        const outcome =
          await this.reconciliationCallbacks.reconcileExpiredSandboxSessionRestore(
            session,
          );
        if (!outcome) {
          preservedRestoringSessionIds.add(session.id);
          continue;
        }
        await this.reconciliationCallbacks.onSessionEvicted(
          session.id,
          session.conversationId,
        );
        if (outcome === 'CHECKPOINTED') {
          restoringReconciled += 1;
        } else {
          restoringTerminated += 1;
        }
        this.cleanup(session.id);
      } catch (error) {
        // Another replica may have completed or reconciled the restore after
        // this scan. Its compare-and-set result is authoritative; one stale
        // row must not abort the rest of lifecycle reconciliation.
        this.logger.warn(
          `${TAG} could not reconcile expired restore for session ${session.id}:`,
          error,
        );
      }
    }

    return {
      restoringReconciled,
      restoringTerminated,
      preservedRestoringSessionIds,
    };
  }

  private async hasPersistedLiveSandboxSession(
    sessionId: string,
  ): Promise<boolean> {
    const current = await this.db.getSandboxSession(sessionId);
    return current !== null && isLiveSandboxSessionStatus(current.status);
  }

  private async reconcileExpiredLifecycleOperations(): Promise<void> {
    const recoverable = await this.db.getRecoverableSandboxSessionLifecycleOperations();
    for (const persistedOperation of recoverable) {
      const observedSession = await this.db.getSandboxSession(
        persistedOperation.sandboxSessionId,
      );
      if (!observedSession || observedSession.status !== 'ACTIVE') {
        continue;
      }
      const lifecycleOperation = await acquireSandboxSessionLifecycleOperation(
        { db: this.db, logger: this.logger },
        persistedOperation.sandboxSessionId,
        persistedOperation.operation,
        {
          expectedActiveGeneration: {
            restoreFenceToken: observedSession.restoreFenceToken,
            containerId: observedSession.containerId,
          },
        },
      );
      if (!lifecycleOperation) {
        continue;
      }
      if (
        lifecycleOperation.operation !== persistedOperation.operation
        || lifecycleOperation.operationId !== persistedOperation.operationId
      ) {
        await lifecycleOperation.stop();
        continue;
      }

      if (lifecycleOperation.operation === 'adopt') {
        const cancelled = await lifecycleOperation.cancel();
        if (cancelled) {
          this.logger.info(
            `${TAG} cancelled abandoned startup adoption for session ` +
            persistedOperation.sandboxSessionId,
          );
        }
        continue;
      }

      if (lifecycleOperation.phase === 'reserved') {
        const cancelled = await lifecycleOperation.cancel();
        if (cancelled) {
          this.logger.info(
            `${TAG} cancelled abandoned reserved ${persistedOperation.operation} ` +
            `for session ${persistedOperation.sandboxSessionId}`,
          );
        }
        continue;
      }

      try {
        if (!await lifecycleOperation.markExecuting()) {
          continue;
        }
        const session = await this.db.getSandboxSession(
          persistedOperation.sandboxSessionId,
        );
        if (!session || session.status !== 'ACTIVE') {
          continue;
        }
        const checkpoint = persistedOperation.operation === 'checkpoint'
          ? await this.db.getCheckpointV2ForLifecycleOperation(
              session.id,
              lifecycleOperation.operationId,
            )
          : persistedOperation.operation === 'reset'
            ? await this.db.getCheckpointV2(session.id)
            : null;
        const resultingStatus = persistedOperation.operation === 'terminate'
          ? 'TERMINATED'
          : checkpoint
            ? 'CHECKPOINTED'
            : 'TERMINATED';
        await this.statusCoordinator.transition({
          sessionId: session.id,
          fromStatus: 'ACTIVE',
          toStatus: resultingStatus,
          clearRuntime: true,
          lifecycleOperation: lifecycleOperation.fence,
        });
        if (session.containerId) {
          await stopAndRemoveContainer(
            this.containerManager,
            session.containerId,
            this.logger,
            `${TAG} recovering ${persistedOperation.operation} for session ${session.id}`,
            5,
          );
        }
        await this.reconciliationCallbacks.onSessionEvicted(
          session.id,
          session.conversationId,
        );
        this.cleanup(session.id);
        this.logger.info(
          `${TAG} recovered expired ${persistedOperation.operation} for ` +
          `session ${session.id} -> ${resultingStatus}`,
        );
      } catch (err) {
        this.logger.error(
          `${TAG} failed recovering ${persistedOperation.operation} for ` +
          `session ${persistedOperation.sandboxSessionId}:`,
          err,
        );
      } finally {
        await lifecycleOperation.stop();
      }
    }
  }

  private async shouldKillContainer(
    containerId: string,
    sessionId?: string,
    currentStatus?: SandboxSessionRow['status'],
  ): Promise<ContainerCleanupDecision> {
    if (!sessionId) {
      return 'kill';
    }

    const entry = this.entries.get(sessionId);
    if (entry && entry.state !== 'none') {
      this.logger.debug(`${TAG} skipping kill for session ${sessionId}; state=${entry.state}`);
      return 'skip';
    }

    const hasLiveDelivery = await this.db.hasLiveTurnDeliveryForSandboxSession(sessionId);
    if (hasLiveDelivery) {
      this.logger.debug(
        `${TAG} skipping kill for session ${sessionId}; ` +
        'a turn has a live delivery lease',
      );
      return 'skip';
    }

    const alive = await this.containerManager.isContainerAlive(containerId);
    if (alive) {
      return 'skip';
    }

    const observedSession = await this.db.getSandboxSession(sessionId);
    if (
      !observedSession
      || observedSession.status !== 'ACTIVE'
      || observedSession.containerId !== containerId
    ) {
      return 'skip';
    }
    const conversationId = this.sessionConversationIds.get(sessionId);
    const resultingStatus = await this.demoteDeadSession(
      sessionId,
      conversationId,
      (currentStatus as SessionStatus) ?? observedSession.status,
      {
        restoreFenceToken: observedSession.restoreFenceToken,
        containerId: observedSession.containerId,
      },
    );
    if (!resultingStatus) {
      return 'skip';
    }
    if (resultingStatus === 'CHECKPOINTED') {
      return 'kill-after-checkpoint';
    }
    return 'kill';
  }

  private async demoteDeadSession(
    sessionId: string,
    conversationId: string | undefined,
    fromStatus: SessionStatus,
    expectedActiveGeneration: SandboxSessionActiveGeneration,
    options: { afterTransition?: () => Promise<void> } = {},
  ): Promise<'CHECKPOINTED' | 'TERMINATED' | undefined> {
    const lifecycleOperation = await acquireSandboxSessionLifecycleOperation(
      { db: this.db, logger: this.logger },
      sessionId,
      'reset',
      { expectedActiveGeneration },
    );
    if (!lifecycleOperation) {
      return undefined;
    }
    if (lifecycleOperation.operation !== 'reset') {
      await lifecycleOperation.stop();
      return undefined;
    }

    const executing = await lifecycleOperation.markExecuting();
    if (!executing) {
      await lifecycleOperation.cancel();
      return undefined;
    }

    try {
      const checkpoint = await this.db.getCheckpointV2(sessionId);
      const resultingStatus = checkpoint ? 'CHECKPOINTED' : 'TERMINATED';
      await this.statusCoordinator.transition({
        sessionId,
        fromStatus,
        toStatus: resultingStatus,
        clearRuntime: true,
        lifecycleOperation: lifecycleOperation.fence,
      });
      await options.afterTransition?.();
      if (conversationId) {
        await this.reconciliationCallbacks.onSessionEvicted(sessionId, conversationId);
      }
      this.cleanup(sessionId);
      this.logger.info(
        checkpoint
          ? `${TAG} session ${sessionId}: dead container, checkpoint exists -> CHECKPOINTED`
          : `${TAG} session ${sessionId}: dead container, no checkpoint -> TERMINATED`,
      );
      return resultingStatus;
    } finally {
      await lifecycleOperation.stop();
    }
  }

  private async releaseMissingContainerSlot(session: SandboxSessionRow): Promise<void> {
    if (!session.containerId) {
      return;
    }

    try {
      await this.containerManager.removeContainer(session.containerId, true);
    } catch (err) {
      this.logger.warn(
        `${TAG} failed releasing missing container slot for session ${session.id} (${session.containerId}):`,
        err,
      );
    }
  }

  private async cleanupManagedContainer(
    container: ContainerInfo,
    reason: string,
    stopTimeoutSec = 10,
  ): Promise<boolean> {
    if (this.removingContainers.has(container.containerId)) {
      return false;
    }

    this.logger.info(
      `${TAG} cleaning container ${container.containerId} (${container.containerName}): ${reason}`,
    );

    this.removingContainers.add(container.containerId);
    try {
      return await stopAndRemoveContainer(
        this.containerManager,
        container.containerId,
        this.logger,
        `${TAG} cleanup for container ${container.containerId}`,
        stopTimeoutSec,
      );
    } finally {
      this.removingContainers.delete(container.containerId);
    }
  }
}
