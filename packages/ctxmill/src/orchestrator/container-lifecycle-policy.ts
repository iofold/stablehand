import { createHash } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { createClient, ConnectError } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import {
  HarnessService,
  KillSessionRequestSchema,
} from '@ctxmill/proto/sandbox/v1';

import { ContainerManager, type ContainerInfo } from '../sandbox/container-manager.js';
import type { DatabaseRepository, SandboxSessionRow } from '../database/repository.js';
import { retryWithBackoff } from '../util/retry.js';

const TAG = '[LifecyclePolicy]';
const DEFAULT_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PAUSE_DELAY_MS = 5_000;
const DEFAULT_MAX_PAUSE_DURATION_MS = 300_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_FREEZE_PROMOTION_MS = 600_000;
const GRPC_PORT = 50051;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;

export type PauseState = 'none' | 'scheduled' | 'paused' | 'promoting' | 'idle_paused' | 'hitl_grace';

export interface IdleCallbacks {
  onFreeze: (sessionId: string) => Promise<void>;
  onCheckpoint: (sessionId: string) => Promise<void>;
  onContainerGone?: (sessionId: string) => Promise<void>;
}

export interface PauseEntry {
  containerId: string;
  state: PauseState;
  pauseTimer?: ReturnType<typeof setTimeout>;
  promotionTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  freezePromotionTimer?: ReturnType<typeof setTimeout>;
  hitlGraceTimer?: ReturnType<typeof setTimeout>;
  idleCallbacks?: IdleCallbacks;
}

interface ManagedContainerWithLabels extends ContainerInfo {
  labels: Record<string, string>;
}

type HarnessGrpcClient = ReturnType<typeof createClient<typeof HarnessService>>;

interface ReadyClient {
  transport: ReturnType<typeof createConnectTransport>;
  grpcClient: HarnessGrpcClient;
}

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface ReconciliationCallbacks {
  onSessionReconnected: (session: SandboxSessionRow, grpcClient?: HarnessGrpcClient) => void;
  onSessionEvicted: (sessionId: string, conversationId: string) => void;
}

export interface ContainerLifecyclePolicyDeps {
  containerManager: ContainerManager;
  db: DatabaseRepository;
  logger: Logger;
  config: {
    reconciliationIntervalMs?: number;
    pauseDelayMs?: number;
    maxPauseDurationMs?: number;
    idleTimeoutMs?: number;
    freezePromotionMs?: number;
  };
  onPromoteToCheckpoint: (sessionId: string) => Promise<void>;
  reconciliationCallbacks: ReconciliationCallbacks;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function sessionContainerName(conversationId: string): string {
  return `ctxmill-session-${shortHash(conversationId)}`;
}

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

function isAliveStatus(status: ContainerInfo['status']): boolean {
  return status === 'running' || status === 'paused' || status === 'created';
}

async function waitForContainerReady(
  baseUrl: string,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<ReadyClient> {
  const transport = createConnectTransport({ baseUrl, httpVersion: '1.1' });
  const grpcClient = createClient(HarnessService, transport);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await grpcClient.killSession(
        create(KillSessionRequestSchema, { sessionId: 'probe', reason: 'probe' }),
      );
      return { transport, grpcClient };
    } catch (err) {
      if (err instanceof ConnectError) {
        return { transport, grpcClient };
      }
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      unrefTimer(timer);
    });
  }

  throw new Error(`Container health check timed out after ${timeoutMs}ms at ${baseUrl}`);
}

export class ContainerLifecyclePolicy {
  private readonly containerManager: ContainerManager;
  private readonly db: DatabaseRepository;
  private readonly logger: Logger;
  private readonly onPromoteToCheckpoint: (sessionId: string) => Promise<void>;
  private readonly reconciliationCallbacks: ReconciliationCallbacks;
  private readonly reconciliationIntervalMs: number;
  private readonly pauseDelayMs: number;
  private readonly maxPauseDurationMs: number;
  private readonly idleTimeoutMs: number;
  private readonly freezePromotionMs: number;
  private readonly entries = new Map<string, PauseEntry>();
  private readonly sessionConversationIds = new Map<string, string>();
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private reconciliationRunning = false;
  private readonly removingContainers = new Set<string>();

  constructor(deps: ContainerLifecyclePolicyDeps) {
    this.containerManager = deps.containerManager;
    this.db = deps.db;
    this.logger = deps.logger;
    this.onPromoteToCheckpoint = deps.onPromoteToCheckpoint;
    this.reconciliationCallbacks = deps.reconciliationCallbacks;
    this.reconciliationIntervalMs = deps.config.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.pauseDelayMs = deps.config.pauseDelayMs ?? DEFAULT_PAUSE_DELAY_MS;
    this.maxPauseDurationMs = deps.config.maxPauseDurationMs ?? DEFAULT_MAX_PAUSE_DURATION_MS;
    this.idleTimeoutMs = deps.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.freezePromotionMs = deps.config.freezePromotionMs ?? DEFAULT_FREEZE_PROMOTION_MS;
  }

  async start(): Promise<void> {
    await this.reconcileOnStartup();

    if (this.reconciliationTimer) {
      this.logger.warn(`${TAG} reconciliation timer already running`);
      return;
    }

    this.reconciliationTimer = setInterval(() => {
      void this.runReconciliation().catch((err) => {
        this.logger.error(`${TAG} periodic reconciliation error:`, err);
      });
    }, this.reconciliationIntervalMs);
    unrefTimer(this.reconciliationTimer);

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

  private clearEntryTimers(entry: PauseEntry): void {
    clearTimeoutSafe(entry.pauseTimer);
    clearTimeoutSafe(entry.promotionTimer);
    clearTimeoutSafe(entry.idleTimer);
    clearTimeoutSafe(entry.freezePromotionTimer);
    clearTimeoutSafe(entry.hitlGraceTimer);
    entry.pauseTimer = undefined;
    entry.promotionTimer = undefined;
    entry.idleTimer = undefined;
    entry.freezePromotionTimer = undefined;
    entry.hitlGraceTimer = undefined;
  }

  schedulePause(sessionId: string, containerId: string): void {
    const existing = this.entries.get(sessionId);
    if (existing && existing.state !== 'none') {
      this.logger.debug(`${TAG} session ${sessionId} pause already ${existing.state}`);
      return;
    }

    const entry: PauseEntry = existing ?? {
      containerId,
      state: 'none',
    };

    clearTimeoutSafe(entry.pauseTimer);
    entry.containerId = containerId;
    entry.state = 'scheduled';
    entry.pauseTimer = setTimeout(() => {
      void this.executePause(sessionId).catch((err) => {
        this.logger.warn(`${TAG} executePause failed for session ${sessionId}:`, err);
      });
    }, this.pauseDelayMs);
    unrefTimer(entry.pauseTimer);

    this.entries.set(sessionId, entry);
    this.logger.debug(`${TAG} scheduled pause for session ${sessionId} in ${this.pauseDelayMs}ms`);
  }

  scheduleHitlGrace(sessionId: string, containerId: string): void {
    const existing = this.entries.get(sessionId);
    if (existing && existing.state !== 'none') {
      this.logger.debug(`${TAG} session ${sessionId} HITL grace already ${existing.state}`);
      return;
    }

    const entry: PauseEntry = existing ?? {
      containerId,
      state: 'none',
    };

    clearTimeoutSafe(entry.hitlGraceTimer);
    entry.containerId = containerId;
    entry.state = 'hitl_grace';
    entry.hitlGraceTimer = setTimeout(() => {
      void this.executeHitlGracePromotion(sessionId).catch((err) => {
        this.logger.error(`${TAG} executeHitlGracePromotion failed for session ${sessionId}:`, err);
      });
    }, this.idleTimeoutMs);
    unrefTimer(entry.hitlGraceTimer);

    this.entries.set(sessionId, entry);
    this.logger.debug(`${TAG} scheduled HITL grace for session ${sessionId} in ${this.idleTimeoutMs}ms`);
  }

  async cancelPause(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }

    this.clearEntryTimers(entry);

    if (entry.state === 'paused') {
      try {
        await this.containerManager.unpauseContainer(entry.containerId);
      } catch (err) {
        this.logger.warn(`${TAG} failed to unpause container ${entry.containerId}:`, err);
      }
    }

    entry.state = 'none';
    this.maybeDeleteEntry(sessionId, entry);
    this.logger.debug(`${TAG} cancelled pause for session ${sessionId}`);
  }

  getState(sessionId: string): PauseState {
    return this.entries.get(sessionId)?.state ?? 'none';
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
    entry.idleTimer = setTimeout(() => {
      void this.executeIdleFreeze(sessionId).catch((err) => {
        this.logger.warn(`${TAG} executeIdleFreeze failed for session ${sessionId}:`, err);
      });
    }, this.idleTimeoutMs);
    unrefTimer(entry.idleTimer);

    this.entries.set(sessionId, entry);
    this.logger.debug(`${TAG} scheduled idle timeout for session ${sessionId} in ${this.idleTimeoutMs}ms`);
  }

  async cancelIdleTimeout(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }

    this.clearEntryTimers(entry);

    if (entry.state === 'idle_paused') {
      try {
        await this.containerManager.unpauseContainer(entry.containerId);
      } catch (err) {
        this.logger.warn(`${TAG} failed to unpause idle-paused container ${entry.containerId}:`, err);
      }
    }

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
    const hasTimers = Boolean(
      entry.pauseTimer
      || entry.promotionTimer
      || entry.idleTimer
      || entry.freezePromotionTimer
      || entry.hitlGraceTimer,
    );

    if (!hasTimers && entry.state === 'none' && !entry.idleCallbacks) {
      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
      return;
    }

    this.entries.set(sessionId, entry);
  }

  private async executePause(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'scheduled') {
      return;
    }

    try {
      await this.containerManager.pauseContainer(entry.containerId);
      entry.pauseTimer = undefined;
      entry.state = 'paused';
      entry.promotionTimer = setTimeout(() => {
        void this.executePromotion(sessionId).catch((err) => {
          this.logger.error(`${TAG} executePromotion failed for session ${sessionId}:`, err);
        });
      }, this.maxPauseDurationMs);
      unrefTimer(entry.promotionTimer);
      this.entries.set(sessionId, entry);
      this.logger.debug(`${TAG} paused session ${sessionId}; promotion in ${this.maxPauseDurationMs}ms`);
    } catch (err) {
      this.logger.warn(`${TAG} failed to pause container ${entry.containerId}:`, err);
      entry.pauseTimer = undefined;
      entry.promotionTimer = undefined;
      entry.state = 'none';
      this.maybeDeleteEntry(sessionId, entry);
    }
  }

  private async executePromotion(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'paused') {
      return;
    }

    entry.promotionTimer = undefined;
    entry.state = 'promoting';
    this.entries.set(sessionId, entry);

    try {
      await this.containerManager.unpauseContainer(entry.containerId);
      await retryWithBackoff(() => this.onPromoteToCheckpoint(sessionId), {
        delays: [1_000, 2_000],
        onRetry: (err, attempt, delayMs) => {
          this.logger.warn(
            `${TAG} retrying checkpoint promotion for session ${sessionId} after attempt ${attempt + 1} in ${delayMs}ms:`,
            err,
          );
        },
      });

      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
      this.logger.debug(`${TAG} promoted paused session ${sessionId} to checkpoint`);
    } catch (err) {
      this.logger.error(`${TAG} failed to promote paused session ${sessionId} to checkpoint:`, err);
      try {
        await this.containerManager.unpauseContainer(entry.containerId);
      } catch (unpauseErr) {
        this.logger.warn(`${TAG} failed to unpause container ${entry.containerId}:`, unpauseErr);
      }

      this.clearEntryTimers(entry);
      entry.state = 'none';

      if (entry.idleCallbacks) {
        this.entries.set(sessionId, entry);
        this.scheduleIdleTimeout(sessionId, entry.containerId, entry.idleCallbacks);
        return;
      }

      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
    }
  }

  private async executeIdleFreeze(sessionId: string): Promise<void> {
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

    try {
      await callbacks.onFreeze(sessionId);
      entry.state = 'idle_paused';
      entry.freezePromotionTimer = setTimeout(() => {
        void this.executeIdlePromotion(sessionId).catch((err) => {
          this.logger.error(`${TAG} executeIdlePromotion failed for session ${sessionId}:`, err);
        });
      }, this.freezePromotionMs);
      unrefTimer(entry.freezePromotionTimer);
      this.entries.set(sessionId, entry);
      this.logger.debug(`${TAG} idle-paused session ${sessionId}; promotion in ${this.freezePromotionMs}ms`);
    } catch (err) {
      if (hasStatusCode(err, 404)) {
        this.logger.warn(`${TAG} container missing during idle freeze for session ${sessionId}`);
        try {
          await callbacks.onContainerGone?.(sessionId);
        } catch (goneErr) {
          this.logger.warn(`${TAG} onContainerGone failed for session ${sessionId}:`, goneErr);
        }
      } else {
        this.logger.warn(`${TAG} failed to idle-freeze session ${sessionId}:`, err);
      }

      entry.state = 'none';
      entry.idleCallbacks = undefined;
      this.maybeDeleteEntry(sessionId, entry);
    }
  }

  private async executeIdlePromotion(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'idle_paused') {
      return;
    }

    const callbacks = entry.idleCallbacks;
    if (!callbacks) {
      entry.freezePromotionTimer = undefined;
      entry.state = 'none';
      this.maybeDeleteEntry(sessionId, entry);
      return;
    }

    entry.freezePromotionTimer = undefined;
    entry.state = 'promoting';
    this.entries.set(sessionId, entry);

    try {
      await retryWithBackoff(() => callbacks.onCheckpoint(sessionId), {
        delays: [1_000, 2_000],
        onRetry: (err, attempt, delayMs) => {
          this.logger.warn(
            `${TAG} retrying idle checkpoint for session ${sessionId} after attempt ${attempt + 1} in ${delayMs}ms:`,
            err,
          );
        },
      });

      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
      this.logger.debug(`${TAG} promoted idle-paused session ${sessionId} to checkpoint`);
    } catch (err) {
      this.logger.error(`${TAG} failed to checkpoint idle-paused session ${sessionId}:`, err);
      try {
        await this.containerManager.unpauseContainer(entry.containerId);
      } catch (unpauseErr) {
        this.logger.warn(`${TAG} failed to unpause container ${entry.containerId}:`, unpauseErr);
      }

      this.clearEntryTimers(entry);
      entry.state = 'none';
      entry.idleCallbacks = undefined;
      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
    }
  }

  private async executeHitlGracePromotion(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.state !== 'hitl_grace') {
      return;
    }

    entry.hitlGraceTimer = undefined;
    entry.state = 'promoting';
    this.entries.set(sessionId, entry);

    try {
      await retryWithBackoff(() => this.onPromoteToCheckpoint(sessionId), {
        delays: [1_000, 2_000],
        onRetry: (err, attempt, delayMs) => {
          this.logger.warn(
            `${TAG} retrying HITL checkpoint for session ${sessionId} after attempt ${attempt + 1} in ${delayMs}ms:`,
            err,
          );
        },
      });

      this.clearEntryTimers(entry);
      this.entries.delete(sessionId);
      this.logger.debug(`${TAG} promoted HITL-grace session ${sessionId} to checkpoint`);
    } catch (err) {
      this.logger.error(`${TAG} failed to checkpoint HITL-grace session ${sessionId}:`, err);
      this.clearEntryTimers(entry);
      entry.state = 'none';

      if (entry.idleCallbacks) {
        this.entries.set(sessionId, entry);
        this.scheduleIdleTimeout(sessionId, entry.containerId, entry.idleCallbacks);
        return;
      }

      this.entries.delete(sessionId);
    }
  }

  private async reconcileOnStartup(): Promise<void> {
    this.logger.info(`${TAG} reconciling sandbox sessions on startup`);

    const [dbSessions, liveContainers] = await Promise.all([
      this.db.getActiveSandboxSessions(),
      this.containerManager.listManagedContainers() as Promise<ContainerInfo[]>,
    ]);

    const containerByName = new Map(liveContainers.map((container) => [container.containerName, container]));
    const knownContainerNames = new Set<string>();
    let reconnected = 0;
    let markedCheckpointed = 0;
    let deleted = 0;
    let orphansCleaned = 0;

    for (const session of dbSessions) {
      this.sessionConversationIds.set(session.id, session.conversationId);
      const containerName = session.containerName ?? sessionContainerName(session.conversationId);
      knownContainerNames.add(containerName);

      const container = containerByName.get(containerName);
      const alive = container !== undefined && isAliveStatus(container.status);

      if (!alive) {
        const checkpoint = await this.db.getCheckpointV2(session.id);
        if (checkpoint) {
           this.logger.info(`${TAG} session ${session.id}: container gone, checkpoint exists -> CHECKPOINTED`);
           await this.db.updateSandboxSessionStatus(session.id, 'CHECKPOINTED');
           this.reconciliationCallbacks.onSessionEvicted(session.id, session.conversationId);
           markedCheckpointed++;
         } else {
           this.logger.info(`${TAG} session ${session.id}: container gone, no checkpoint -> TERMINATED`);
           await this.db.updateSandboxSessionStatus(session.id, 'TERMINATED');
          this.reconciliationCallbacks.onSessionEvicted(session.id, session.conversationId);
          deleted++;
        }
        this.cleanup(session.id);
        continue;
      }

      if (session.status === 'ACTIVE' && container.status !== 'paused') {
        this.logger.info(`${TAG} session ${session.id}: container running, reconnecting gRPC client`);
        const baseUrl = `http://${containerName}:${GRPC_PORT}`;
        const { grpcClient } = await waitForContainerReady(baseUrl);
        this.reconciliationCallbacks.onSessionReconnected(session, grpcClient);
        reconnected++;
      } else if (session.status === 'PAUSED' && container.status === 'paused') {
        this.logger.info(`${TAG} session ${session.id}: container paused (${session.status}), caching lazy unfreeze state`);
        this.reconciliationCallbacks.onSessionReconnected(session);
        reconnected++;
      }
    }

    for (const container of liveContainers) {
      if (knownContainerNames.has(container.containerName)) {
        continue;
      }

      if (this.removingContainers.has(container.containerId)) continue;

      this.logger.info(`${TAG} removing orphan container ${container.containerName} (${container.containerId})`);
      this.removingContainers.add(container.containerId);
      try {
        await this.containerManager.stopContainer(container.containerId, 5);
        await this.containerManager.removeContainer(container.containerId, true);
        orphansCleaned++;
      } catch (err) {
        if (hasStatusCode(err, 404)) {
          orphansCleaned++;
        } else {
          this.logger.warn(`${TAG} failed cleaning orphan container ${container.containerName}:`, err);
        }
      } finally {
        this.removingContainers.delete(container.containerId);
      }
    }

    this.logger.info(
      `${TAG} reconciliation complete: reconnected=${reconnected}, markedCheckpointed=${markedCheckpointed}, deleted=${deleted}, orphansCleaned=${orphansCleaned}`,
    );
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
      const killableContainerIds = new Set<string>();
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

        const checkpoint = await this.db.getCheckpointV2(session.id);
        const decision = await this.shouldKillContainer(containerId, session.id);
        if (decision === 'kill') {
          killableContainerIds.add(containerId);
          terminated++;
        } else if (checkpoint) {
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
        const shouldReview = killableContainerIds.has(container.containerId) || !hasActiveSession || isExpired;

        if (!shouldReview) {
          continue;
        }

        const decision = killableContainerIds.has(container.containerId)
          ? 'kill'
          : await this.shouldKillContainer(container.containerId, sessionId);

        if (decision !== 'kill') {
          continue;
        }

        let reason = 'container eligible for cleanup';
        if (!hasActiveSession && sessionId) {
          reason = 'no matching active session in DB';
        } else if (!hasActiveSession && !sessionId) {
          reason = 'container has no associated session';
        } else if (isExpired) {
          reason = 'container exceeded timeout';
        } else if (killableContainerIds.has(container.containerId)) {
          reason = 'session container dead with no checkpoint';
        }

        if (this.removingContainers.has(container.containerId)) continue;

        this.logger.info(
          `${TAG} cleaning container ${container.containerId} (${container.containerName}): ${reason}`,
        );

        this.removingContainers.add(container.containerId);
        try {
          await this.containerManager.stopContainer(container.containerId, 10);
          await this.containerManager.removeContainer(container.containerId, true);
          cleaned++;
        } catch (err) {
          if (hasStatusCode(err, 404)) {
            cleaned++;
          } else {
            this.logger.warn(`${TAG} failed cleaning container ${container.containerId}:`, err);
          }
        } finally {
          this.removingContainers.delete(container.containerId);
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
  ): Promise<'kill' | 'skip'> {
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
      await this.db.updateSandboxSessionStatus(sessionId, 'CHECKPOINTED');
      if (conversationId) {
        this.reconciliationCallbacks.onSessionEvicted(sessionId, conversationId);
      }
      this.cleanup(sessionId);
      this.logger.info(`${TAG} session ${sessionId}: dead container ${containerId}, checkpoint exists -> CHECKPOINTED`);
      return 'skip';
    }

    await this.db.updateSandboxSessionStatus(sessionId, 'TERMINATED');
    if (conversationId) {
      this.reconciliationCallbacks.onSessionEvicted(sessionId, conversationId);
    }
    this.cleanup(sessionId);
    this.logger.info(`${TAG} session ${sessionId}: dead container ${containerId}, no checkpoint -> TERMINATED`);
    return 'kill';
  }
}
