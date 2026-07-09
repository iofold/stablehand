import {
  DEFAULT_CONTAINER_STARTUP_GRACE_MS,
  STARTUP_GRACE_MS_LABEL,
  type ContainerInfo,
  type SandboxContainerManager,
} from '../sandbox/container-manager.js';
import type { DatabaseRepository, SandboxSessionRow } from '../database/repository.js';
import { retryWithBackoff } from '../util/retry.js';
import {
  type HarnessGrpcClient,
  waitForContainerReady,
} from './session-manager/grpc-session-client.js';
import { sandboxGrpcBaseUrl } from './session-manager/sandbox-endpoint.js';
import type { SessionStatusCoordinator } from './session-manager/session-status-coordinator.js';
import type { SessionStatus } from './session-manager/types.js';
import { isAliveContainerStatus } from '../sandbox/runtime/status.js';

const TAG = '[LifecyclePolicy]';
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const MAX_IDLE_CHECKPOINT_FAILURES = 3;

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
  onSessionReconnected: (session: SandboxSessionRow, grpcClient?: HarnessGrpcClient) => void;
  onSessionEvicted: (sessionId: string, conversationId: string) => void | Promise<void>;
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

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}

function clearTimeoutSafe(timer?: ReturnType<typeof setTimeout>): void {
  if (timer) {
    clearTimeout(timer);
  }
}

function hasStatusCode(err: unknown, statusCode: number): boolean {
  return typeof err === 'object'
    && err !== null
    && 'statusCode' in err
    && typeof (err as { statusCode?: unknown }).statusCode === 'number'
    && (err as { statusCode: number }).statusCode === statusCode;
}

function parsePositiveMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
  private reconciliationRunning = false;
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

    this.logger.info(
      `${TAG} started periodic reconciliation every ${this.reconciliationIntervalMs / 1000}s`,
    );
  }

  stop(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
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

  private armIdleTimer(sessionId: string, entry: PauseEntry): void {
    clearTimeoutSafe(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.executeIdleCheckpoint(sessionId).catch((err) => {
        this.logger.warn(`${TAG} idle checkpoint failed for session ${sessionId}:`, err);
      });
    }, this.idleTimeoutMs);
    unrefTimer(entry.idleTimer);
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

  scheduleIdleTimeout(sessionId: string, containerId: string, callbacks: IdleCallbacks): void {
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

    entry.state = 'promoting';
    this.entries.set(sessionId, entry);
    this.logger.debug(`${TAG} idle timeout reached for session ${sessionId}, checkpointing directly`);

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
    }
  }

  private async reconcileOnStartup(): Promise<void> {
    this.logger.info(`${TAG} reconciling sandbox sessions on startup`);

    const [dbSessions, strandedRestoring, liveContainers] = await Promise.all([
      this.db.getActiveSandboxSessions(),
      this.db.getStrandedRestoringSessions(),
      this.containerManager.listManagedContainersWithLabels(),
    ]);

    // ctx-7fz: roll any session stranded in RESTORING back to a recoverable
    // state. This must run before container reconciliation so the rest of the
    // pass sees a consistent ACTIVE/CHECKPOINTED set.
    let restoringReconciled = 0;
    let restoringTerminated = 0;
    for (const stranded of strandedRestoring) {
      this.sessionConversationIds.set(stranded.id, stranded.conversationId);
      const checkpoint = await this.db.getCheckpointV2(stranded.id);
      if (checkpoint) {
        this.logger.warn(
          `${TAG} startup: session ${stranded.id} stranded in RESTORING (attempts=${stranded.restoreAttempts ?? 0}) -> CHECKPOINTED`,
        );
        await this.statusCoordinator.transition({
          sessionId: stranded.id,
          fromStatus: 'RESTORING',
          toStatus: 'CHECKPOINTED',
          clearRuntime: true,
          extra: {
            lastRestoreError:
              stranded.lastRestoreError ?? 'orchestrator restarted while restoring',
          },
        });
        await this.reconciliationCallbacks.onSessionEvicted(stranded.id, stranded.conversationId);
        restoringReconciled++;
      } else {
        this.logger.warn(
          `${TAG} startup: session ${stranded.id} stranded in RESTORING with no checkpoint -> TERMINATED`,
        );
        await this.statusCoordinator.transition({
          sessionId: stranded.id,
          fromStatus: 'RESTORING',
          toStatus: 'TERMINATED',
          clearRuntime: true,
          extra: {
            lastRestoreError: 'orchestrator restart: no recoverable checkpoint',
          },
        });
        await this.reconciliationCallbacks.onSessionEvicted(stranded.id, stranded.conversationId);
        restoringTerminated++;
      }
      this.cleanup(stranded.id);
    }
    if (strandedRestoring.length > 0) {
      this.logger.info(
        `${TAG} stranded-RESTORING reconciliation: checkpointed=${restoringReconciled}, terminated=${restoringTerminated}`,
      );
    }

    const containerByName = new Map(liveContainers.map((container) => [container.containerName, container]));
    const containerById = new Map(liveContainers.map((container) => [container.containerId, container]));
    const knownContainerIds = new Set<string>();
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

      if (!alive) {
        const checkpoint = await this.db.getCheckpointV2(session.id);
        if (checkpoint) {
           this.logger.info(`${TAG} session ${session.id}: container gone, checkpoint exists -> CHECKPOINTED`);
             await this.statusCoordinator.transition({
               sessionId: session.id,
               fromStatus: session.status as SessionStatus,
               toStatus: 'CHECKPOINTED',
               clearRuntime: true,
             });
           await this.reconciliationCallbacks.onSessionEvicted(session.id, session.conversationId);
           markedCheckpointed++;
         } else {
           this.logger.info(`${TAG} session ${session.id}: container gone, no checkpoint -> TERMINATED`);
           await this.statusCoordinator.transition({
             sessionId: session.id,
             fromStatus: session.status as SessionStatus,
             toStatus: 'TERMINATED',
             clearRuntime: true,
           });
           await this.reconciliationCallbacks.onSessionEvicted(session.id, session.conversationId);
          deleted++;
        }
        if (container && await this.cleanupManagedContainer(
          container,
          checkpoint
            ? 'dead container retained after checkpoint promotion'
            : 'dead container retained after session termination',
        )) {
          deadCleaned++;
        }
        this.cleanup(session.id);
        continue;
      }

      if (session.status === 'ACTIVE' && container.status !== 'paused') {
        let reconnectedSession = session;
        if (session.containerName !== container.containerName || session.containerId !== container.containerId) {
          await this.statusCoordinator.transition({
            sessionId: session.id,
            fromStatus: session.status as SessionStatus,
            toStatus: session.status as SessionStatus,
            extra: {
              containerName: container.containerName,
              containerId: container.containerId,
            },
          });
          reconnectedSession = {
            ...session,
            containerName: container.containerName,
            containerId: container.containerId,
          };
        }

        this.logger.info(`${TAG} session ${session.id}: container running, reconnecting gRPC client`);
        const baseUrl = sandboxGrpcBaseUrl(container);
        const { grpcClient } = await waitForContainerReady(baseUrl);
        this.reconciliationCallbacks.onSessionReconnected(reconnectedSession, grpcClient);
        reconnected++;
      }
    }

    for (const container of liveContainers) {
      if (knownContainerIds.has(container.containerId)) {
        continue;
      }

      if (this.removingContainers.has(container.containerId)) continue;

      if (this.shouldDeferUnownedStartupContainer(container, container.labels['ctxmill.session-id'])) {
        continue;
      }

      this.logger.info(`${TAG} removing orphan container ${container.containerName} (${container.containerId})`);
      this.removingContainers.add(container.containerId);
      let stopError: unknown;
      try {
        await this.containerManager.stopContainer(container.containerId, 5);
      } catch (err) {
        stopError = err;
        this.logger.warn(`${TAG} failed stopping orphan container ${container.containerName}; attempting force removal:`, err);
      }

      try {
        await this.containerManager.removeContainer(container.containerId, true);
        orphansCleaned++;
      } catch (err) {
        if (hasStatusCode(err, 404)) {
          orphansCleaned++;
        } else {
          this.logger.warn(
            `${TAG} failed cleaning orphan container ${container.containerName}:`,
            err,
            stopError ? { stopError } : undefined,
          );
        }
      } finally {
        this.removingContainers.delete(container.containerId);
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
      const labelSessionId = container.labels['ctxmill.session-id'] || container.labels['ctxmill.run-id'];
      return labelSessionId === session.id;
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
        if (session.containerName !== container.containerName || session.containerId !== container.containerId) {
          await this.statusCoordinator.transition({
            sessionId: session.id,
            fromStatus: session.status as SessionStatus,
            toStatus: session.status as SessionStatus,
            extra: {
              containerName: container.containerName,
              containerId: container.containerId,
            },
          });
          activeRows.push({
            ...session,
            containerName: container.containerName,
            containerId: container.containerId,
          });
        } else {
          activeRows.push(session);
        }
        continue;
      }

      if (options.shouldDefer?.(session)) {
        activeRows.push(session);
        continue;
      }

      const checkpoint = await this.db.getCheckpointV2(session.id);
      await this.statusCoordinator.transition({
        sessionId: session.id,
        fromStatus: session.status as SessionStatus,
        toStatus: checkpoint ? 'CHECKPOINTED' : 'TERMINATED',
        clearRuntime: true,
      });
      await this.releaseMissingContainerSlot(session);
      await this.reconciliationCallbacks.onSessionEvicted(session.id, session.conversationId);
      this.cleanup(session.id);
      this.logger.info(
        checkpoint
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
      const [dbSessions, managedContainers] = await Promise.all([
        this.db.getActiveSandboxSessions(),
        this.containerManager.listManagedContainersWithLabels() as Promise<ManagedContainerWithLabels[]>,
      ]);

      for (const session of dbSessions) {
        this.sessionConversationIds.set(session.id, session.conversationId);
      }

      const activeSessionIds = new Set(dbSessions.map((session) => session.id));
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
        const sessionId = container.labels['ctxmill.session-id'];
        const timeoutSec = Number.parseInt(container.labels['ctxmill.timeout'] ?? '600', 10);
        const startedAtRaw = container.labels['ctxmill.started-at'];
        const startedAtMs = startedAtRaw ? new Date(startedAtRaw).getTime() : Number.NaN;
        const isExpired = Number.isFinite(startedAtMs)
          && timeoutSec > 0
          && (Date.now() - startedAtMs) / 1000 > timeoutSec;
        const hasActiveSession = sessionId !== undefined && activeSessionIds.has(sessionId);
        if (
          !cleanupReasons.has(container.containerId)
          && !hasActiveSession
          && this.shouldDeferUnownedStartupContainer(container, sessionId)
        ) {
          continue;
        }
        const shouldReview = cleanupReasons.has(container.containerId) || !hasActiveSession || isExpired;

        if (!shouldReview) {
          continue;
        }

        const decision = cleanupReasons.has(container.containerId) || !hasActiveSession
          ? 'kill'
          : await this.shouldKillContainer(container.containerId, sessionId);

        if (decision !== 'kill') {
          continue;
        }

        let reason = cleanupReasons.get(container.containerId) ?? 'container eligible for cleanup';
        if (!cleanupReasons.has(container.containerId) && !hasActiveSession && sessionId) {
          reason = 'no matching active session in DB';
        } else if (!cleanupReasons.has(container.containerId) && !hasActiveSession && !sessionId) {
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

    const alive = await this.containerManager.isContainerAlive(containerId);
    if (alive) {
      return 'skip';
    }

    const checkpoint = await this.db.getCheckpointV2(sessionId);
    const conversationId = this.sessionConversationIds.get(sessionId);

    if (checkpoint) {
      await this.statusCoordinator.transition({
        sessionId,
        fromStatus: (currentStatus as SessionStatus) ?? 'ACTIVE',
        toStatus: 'CHECKPOINTED',
        clearRuntime: true,
      });
      if (conversationId) {
        await this.reconciliationCallbacks.onSessionEvicted(sessionId, conversationId);
      }
      this.cleanup(sessionId);
      this.logger.info(`${TAG} session ${sessionId}: dead container ${containerId}, checkpoint exists -> CHECKPOINTED`);
      return 'kill-after-checkpoint';
    }

    await this.statusCoordinator.transition({
      sessionId,
      fromStatus: (currentStatus as SessionStatus) ?? 'ACTIVE',
      toStatus: 'TERMINATED',
      clearRuntime: true,
    });
    if (conversationId) {
      await this.reconciliationCallbacks.onSessionEvicted(sessionId, conversationId);
    }
    this.cleanup(sessionId);
    this.logger.info(`${TAG} session ${sessionId}: dead container ${containerId}, no checkpoint -> TERMINATED`);
    return 'kill';
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

  private async cleanupManagedContainer(container: ContainerInfo, reason: string): Promise<boolean> {
    if (this.removingContainers.has(container.containerId)) {
      return false;
    }

    this.logger.info(
      `${TAG} cleaning container ${container.containerId} (${container.containerName}): ${reason}`,
    );

    this.removingContainers.add(container.containerId);
    let stopError: unknown;
    try {
      await this.containerManager.stopContainer(container.containerId, 10);
    } catch (err) {
      stopError = err;
      this.logger.warn(`${TAG} failed stopping container ${container.containerId}; attempting force removal:`, err);
    }

    try {
      await this.containerManager.removeContainer(container.containerId, true);
      return true;
    } catch (err) {
      if (hasStatusCode(err, 404)) {
        return true;
      }
      this.logger.warn(
        `${TAG} failed cleaning container ${container.containerId}:`,
        err,
        stopError ? { stopError } : undefined,
      );
      return false;
    } finally {
      this.removingContainers.delete(container.containerId);
    }
  }
}
