import { create } from '@bufbuild/protobuf';
import type { JsonObject } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  OpenSessionRequestSchema,
  ToolMetadataSchema,
} from '@stablehand/proto/sandbox/v1';
import { createHash } from 'node:crypto';

import type { ContainerInfo, SandboxContainerManager } from '../../sandbox/container-manager.js';
import { WorkspaceDiffService } from '../../sandbox/workspace-diff.js';
import {
  LiveSandboxSessionConflictError,
  type DatabaseRepository,
  type SandboxSessionRow,
} from '../../database/repository.js';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import { stopAndRemoveContainer } from '../container-cleanup.js';
import type {
  SessionReconnectionRegistration,
  SessionReconciler,
  SessionStatePort,
} from './ports.js';
import {
  createRuntimeInstanceToken,
  retryGrpcCall,
  waitForContainerReady,
} from './grpc-session-client.js';
import { RUNTIME_INSTANCE_TOKEN_ENV } from '@stablehand/shared';
import { nativeToolPolicyToProto } from './native-tool-policy-proto.js';
import { resolveAgentToolNames } from '../agent-definition.js';
import type { BuiltinToolPolicy } from '@stablehand/contracts';
import { getGrpcCallbackSandboxSecrets } from '../grpc/callback-auth.js';
import {
  decideRestoreOutcome,
  InvalidCheckpointError,
  isCapacityError,
  MAX_RESTORE_ATTEMPTS,
  RESTORE_BACKOFF_MS,
  RESTORE_JOIN_MAX_POLLS,
  RESTORE_JOIN_POLL_MS,
} from './restore-retry-policy.js';
import { sandboxGrpcBaseUrl } from './sandbox-endpoint.js';
import { SessionStatusCoordinator } from './session-status-coordinator.js';
import {
  applyWorkspaceSetup,
  WorkspaceSetupError,
} from './workspace-setup.js';
import { acquireSandboxSessionLifecycleOperation } from '../sandbox-session-lifecycle-operation.js';
import { acquireSandboxSessionRestoreLease } from '../sandbox-session-restore-lease.js';
import type {
  HarnessGrpcClient,
  Logger,
  SessionRecoveryAuthority,
  SessionRecord,
  ToolMetadata,
} from './types.js';
import { dbSessionToRecord } from './types.js';
import {
  performanceInstrumentation,
  type PerformanceRecorder,
} from '../../observability/performance.js';

const TAG = '[SandboxSessionManager]';
const TRANSPORT_ERROR_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|UND_ERR_SOCKET|socket hang up/i;

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function sessionContainerName(conversationId: string): string {
  return `stablehand-session-${shortHash(conversationId)}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export { InvalidCheckpointError };

export class SessionRecoveryConflictError extends Error {
  constructor(readonly sandboxSessionId: string) {
    super(
      `Could not acquire recovery ownership for sandbox session ${sandboxSessionId}; ` +
      'another lifecycle operation or an unsettled turn is still active',
    );
    this.name = 'SessionRecoveryConflictError';
  }
}

export class SessionRestoreInProgressError extends Error {
  constructor(readonly sandboxSessionId: string, cause?: unknown) {
    super(
      `Sandbox session ${sandboxSessionId} is still being restored by another worker`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'SessionRestoreInProgressError';
  }
}

/**
 * ctx-2mm8: the restore budget is spent (restore_attempts >= MAX). Distinct
 * from SessionRestoreInProgressError so the caller is not told a peer owns the
 * restore when in fact the session ran out of attempts. The message names the
 * likely cause (a full host burning attempts is the common case pre-fix).
 */
export class SessionRestoreBudgetExhaustedError extends Error {
  constructor(readonly sandboxSessionId: string, cause?: unknown) {
    super(
      `Restore budget exhausted for sandbox session ${sandboxSessionId} `
      + '(container capacity or repeated restore failures)',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'SessionRestoreBudgetExhaustedError';
  }
}

export interface SessionRecoveryCoordinatorDeps {
  containerManager: Pick<
    SandboxContainerManager,
    | 'createContainer'
    | 'startContainer'
    | 'stopContainer'
    | 'removeContainer'
    | 'getContainer'
    | 'getRuntimeInstanceToken'
  >;
  db: Pick<
    DatabaseRepository,
    | 'getCheckpointV2'
    | 'getSandboxSession'
    | 'getLiveSandboxSessionByConversation'
    | 'claimSandboxSessionLifecycleOperation'
    | 'renewSandboxSessionLifecycleOperation'
    | 'markSandboxSessionLifecycleOperationExecuting'
    | 'cancelSandboxSessionLifecycleOperation'
    | 'claimSandboxSessionRestore'
    | 'renewSandboxSessionRestoreLease'
    | 'completeSandboxSessionRestore'
    | 'failSandboxSessionRestore'
    | 'reconcileExpiredSandboxSessionRestore'
  >;
  statusCoordinator: SessionStatusCoordinator;
  stateStore: SessionStatePort;
  buildSandboxSecrets: (agentId: string) => Promise<Readonly<Record<string, string>>>;
  resolveToolsForAgent: (
    toolNames: string[],
    builtinToolPolicy?: BuiltinToolPolicy,
    agentId?: string,
  ) => ToolMetadata[];
  workspaceDiffService: WorkspaceDiffService;
  logger: Logger;
  createFreshSession: (
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
    options?: {
      concurrencyReservationId?: string;
      runtimeDefinitionHash?: string;
    },
  ) => Promise<SessionRecord>;
  getExistingConversationWorkspaceDir: (agentId: string, conversationId: string) => Promise<string | undefined>;
  onActiveSessionReconnected?: (
    record: SessionRecord,
  ) => SessionReconnectionRegistration | void;
  /**
   * Optional sleep injection for tests. Defaults to a real timer that supports
   * AbortSignal cancellation.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  performance?: PerformanceRecorder;
}

export class SessionRecoveryCoordinator implements SessionReconciler {
  private readonly activeRecoveries = new Map<string, Promise<SessionRecord>>();

  constructor(private readonly deps: SessionRecoveryCoordinatorDeps) {}

  async recoverOrReconnect(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    dbSession: SandboxSessionRow,
    recoveryAuthority?: SessionRecoveryAuthority,
  ): Promise<SessionRecord> {
    const existing = this.activeRecoveries.get(conversationId);
    if (existing) {
      return existing;
    }

    const recovery = this.doRecover(
      conversationId,
      agentDef,
      agentId,
      dbSession,
      recoveryAuthority,
    );
    this.activeRecoveries.set(conversationId, recovery);

    try {
      const record = await recovery;
      this.deps.stateStore.setSession(conversationId, record);
      return record;
    } finally {
      if (this.activeRecoveries.get(conversationId) === recovery) {
        this.activeRecoveries.delete(conversationId);
      }
    }
  }

  public onSessionReconnected(
    session: SandboxSessionRow,
    grpcClient?: HarnessGrpcClient,
  ): SessionReconnectionRegistration;
  public onSessionReconnected(
    conversationId: string,
    record: SessionRecord,
  ): SessionReconnectionRegistration;
  public onSessionReconnected(
    sessionOrConversationId: SandboxSessionRow | string,
    grpcClientOrRecord?: HarnessGrpcClient | SessionRecord,
  ): SessionReconnectionRegistration {
    let conversationId: string;
    let record: SessionRecord;
    let shouldNotifyActiveRuntime = false;

    if (typeof sessionOrConversationId === 'string') {
      if (!this.isSessionRecord(grpcClientOrRecord)) {
        throw new Error('onSessionReconnected requires a SessionRecord when called with a conversationId');
      }
      conversationId = sessionOrConversationId;
      record = grpcClientOrRecord;
    } else {
      conversationId = sessionOrConversationId.conversationId;
      record = dbSessionToRecord(
        sessionOrConversationId,
        this.isSessionRecord(grpcClientOrRecord)
          ? undefined
          : grpcClientOrRecord,
      );
      shouldNotifyActiveRuntime = true;
    }

    this.deps.stateStore.setSession(conversationId, record);
    let activeRuntimeRegistration: SessionReconnectionRegistration | void;
    try {
      if (shouldNotifyActiveRuntime) {
        activeRuntimeRegistration =
          this.deps.onActiveSessionReconnected?.(record);
      }
    } catch (error) {
      if (
        this.deps.stateStore.getSessionByConversation(conversationId)
          === record
      ) {
        this.deps.stateStore.deleteSession(conversationId);
      }
      throw error;
    }

    let revoked = false;
    return {
      revoke: async () => {
        if (revoked) {
          return;
        }
        revoked = true;
        if (
          this.deps.stateStore.getSessionByConversation(conversationId)
            !== record
        ) {
          return;
        }
        this.deps.stateStore.deleteSession(conversationId);
        await activeRuntimeRegistration?.revoke();
      },
    };
  }

  async onSessionEvicted(sessionId: string, conversationId: string): Promise<void> {
    await this.deps.stateStore.withConversationLock(conversationId, async () => {
      if (this.deps.stateStore.isActiveTurn(sessionId)) {
        this.deps.logger.warn(
          `${TAG} skipping eviction of session ${sessionId}: turn still active, reconciliation will retry`,
        );
        return;
      }

      this.deps.stateStore.cleanupSession(sessionId, conversationId);
    });
  }

  async reconnectToContainer(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
  ): Promise<SessionRecord> {
    const runtimeContainer = await this.deps.containerManager.getContainer(dbSession.id);
    const containerName = runtimeContainer?.containerName ?? dbSession.containerName ?? sessionContainerName(dbSession.conversationId);
    const containerId = runtimeContainer?.containerId ?? dbSession.containerId ?? '';
    const baseUrl = sandboxGrpcBaseUrl(runtimeContainer ?? { containerName });

    this.deps.logger.info(
      `${TAG} reconnecting to container ${containerName} for session ${dbSession.id}`,
    );

    const runtimeInstanceToken =
      await this.deps.containerManager.getRuntimeInstanceToken(containerId);
    if (!runtimeInstanceToken) {
      throw new Error(
        `Container ${containerId || containerName} has no runtime instance token`,
      );
    }
    const { grpcClient } = await waitForContainerReady(baseUrl, {
      runtimeInstanceToken,
    });
    const sessionWorkspaceDir = await this.deps.getExistingConversationWorkspaceDir(dbSession.agentId, dbSession.conversationId);
    await applyWorkspaceSetup(
      sessionWorkspaceDir ?? agentDef.workspaceDir,
      agentDef.harnessConfig,
    );

    return {
      sessionId: dbSession.id,
      conversationId: dbSession.conversationId,
      agentId: dbSession.agentId,
      containerName,
      containerId,
      restoreFenceToken: dbSession.restoreFenceToken,
      runtimeDefinitionHash: dbSession.runtimeDefinitionHash ?? '',
      status: 'ACTIVE',
      harnessName: dbSession.harnessName,
      grpcClient,
      sessionWorkspaceDir,
    };
  }

  async restoreFromCheckpoint(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
  ): Promise<SessionRecord> {
    return this.restoreFromCheckpointWithRetry(dbSession, agentDef);
  }

  /**
   * Single restore attempt. Sets `RESTORING`, performs the restore, transitions
   * to `ACTIVE` on success. On failure transitions to `CHECKPOINTED` (retryable)
   * or `TERMINATED` (non-retryable) per ADR 005. Throws the underlying error.
   *
   * Callers that want auto-retry should use `restoreFromCheckpointWithRetry`.
   */
  async restoreFromCheckpointOnce(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
  ): Promise<SessionRecord> {
    return (this.deps.performance ?? performanceInstrumentation).measure(
      'session.restore',
      {
        'stablehand.harness': dbSession.harnessName,
        'stablehand.session.id': dbSession.id,
        'stablehand.agent.id': dbSession.agentId,
        'stablehand.conversation.id': dbSession.conversationId,
        'stablehand.session.state': 'checkpointed',
      },
      () => this.restoreFromCheckpointOnceMeasured(dbSession, agentDef),
    );
  }

  private async restoreFromCheckpointOnceMeasured(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
  ): Promise<SessionRecord> {
    if (dbSession.status !== 'CHECKPOINTED') {
      throw new Error(
        `Restore attempt for session ${dbSession.id} requires CHECKPOINTED status, received ${dbSession.status}`,
      );
    }
    const harnessName = dbSession.harnessName;
    const sessionId = dbSession.id;
    const performance = this.deps.performance ?? performanceInstrumentation;
    const performanceAttributes = {
      'stablehand.harness': harnessName,
      'stablehand.session.id': sessionId,
      'stablehand.agent.id': dbSession.agentId,
      'stablehand.conversation.id': dbSession.conversationId,
      'stablehand.session.state': 'checkpointed',
    };

    this.deps.logger.info(`${TAG} restoring session ${sessionId} from checkpoint`);
    const restoreLease = await acquireSandboxSessionRestoreLease(
      { db: this.deps.db, logger: this.deps.logger },
      sessionId,
      MAX_RESTORE_ATTEMPTS,
    );
    if (!restoreLease) {
      // ctx-2mm8: a failed claim means either a peer owns the restore or the
      // budget is spent. Read the row to name the real cause instead of always
      // reporting "restored by another worker".
      const current = await this.deps.db.getSandboxSession(sessionId);
      if (
        current
        && current.status === 'CHECKPOINTED'
        && (current.restoreAttempts ?? 0) >= MAX_RESTORE_ATTEMPTS
      ) {
        throw new SessionRestoreBudgetExhaustedError(sessionId);
      }
      throw new SessionRestoreInProgressError(sessionId);
    }
    const restoreAttempt = Math.max(
      1,
      restoreLease.session.restoreAttempts ?? 1,
    );

    let createdContainer: ContainerInfo | undefined;

    try {
      restoreLease.signal.throwIfAborted();
      const abandonedRuntime =
        await this.deps.containerManager.getContainer(sessionId);
      restoreLease.signal.throwIfAborted();
      if (abandonedRuntime) {
        await stopAndRemoveContainer(
          this.deps.containerManager,
          abandonedRuntime.containerId,
          this.deps.logger,
          `${TAG} expired restore runtime cleanup for ${sessionId}`,
          10,
        );
      }
      restoreLease.signal.throwIfAborted();
      const checkpoint = await this.deps.db.getCheckpointV2(sessionId);
      restoreLease.signal.throwIfAborted();
      if (!checkpoint) {
        throw new InvalidCheckpointError(`No checkpoint found for session ${sessionId}`);
      }

      const sessionWorkspaceDir = agentDef.workspaceDir
        ? await this.deps.getExistingConversationWorkspaceDir(dbSession.agentId, dbSession.conversationId)
        : undefined;
      restoreLease.signal.throwIfAborted();
      if (agentDef.workspaceDir && !sessionWorkspaceDir) {
        throw new InvalidCheckpointError(
          `Missing persisted conversation workspace for checkpointed session ${sessionId}`,
        );
      }

      const workspaceDir = sessionWorkspaceDir ?? agentDef.workspaceDir;
      await applyWorkspaceSetup(workspaceDir, agentDef.harnessConfig);
      restoreLease.signal.throwIfAborted();
      const runtimeInstanceToken = createRuntimeInstanceToken();
      const stableSandboxSecrets = {
        ...(await this.deps.buildSandboxSecrets(dbSession.agentId)),
        ...getGrpcCallbackSandboxSecrets(sessionId, dbSession.agentId),
        [RUNTIME_INSTANCE_TOKEN_ENV]: runtimeInstanceToken,
      };
      restoreLease.signal.throwIfAborted();
      const secretKeys = Object.keys(stableSandboxSecrets);
      this.deps.logger.info(`${TAG} injecting ${secretKeys.length} secrets: [${secretKeys.join(', ')}]`);

      const containerInfo = await this.deps.containerManager.createContainer({
        sessionId,
        conversationId: dbSession.conversationId,
        agentId: dbSession.agentId,
        harnessName,
        workspaceDir,
        cpus: agentDef.resourceLimits?.cpus,
        memoryMb: agentDef.resourceLimits?.memoryMb,
        pidsLimit: agentDef.resourceLimits?.pidsLimit,
        timeoutSec: agentDef.resourceLimits?.timeoutSec,
        secrets: stableSandboxSecrets,
      });
      createdContainer = containerInfo;
      restoreLease.signal.throwIfAborted();

      const startedContainerInfo = await performance.measure(
        'sandbox.start',
        performanceAttributes,
        () => this.deps.containerManager.startContainer(containerInfo.containerId),
      );
      restoreLease.signal.throwIfAborted();
      const reachableContainerInfo = startedContainerInfo?.containerName ? startedContainerInfo : containerInfo;

      if (!sessionWorkspaceDir) {
        await performance.measure(
          'workspace.restore',
          performanceAttributes,
          () => this.deps.workspaceDiffService.restore(
            sessionId,
            containerInfo.containerId,
          ),
        );
        restoreLease.signal.throwIfAborted();
        this.deps.logger.info(`${TAG} workspace restored for session ${sessionId}`);
      } else {
        this.deps.logger.info(
          `${TAG} reusing persisted conversation workspace for session ${sessionId}: ${sessionWorkspaceDir}`,
        );
      }

      const baseUrl = sandboxGrpcBaseUrl(reachableContainerInfo);
      const { grpcClient } = await performance.measure(
        'sandbox.ready',
        performanceAttributes,
        () => waitForContainerReady(baseUrl, {
          runtimeInstanceToken,
          signal: restoreLease.signal,
        }),
      );
      restoreLease.signal.throwIfAborted();

      const restoreTools = this.deps.resolveToolsForAgent(
        resolveAgentToolNames(agentDef),
        agentDef.builtinToolPolicy,
        dbSession.agentId,
      );
      const openReq = create(OpenSessionRequestSchema, {
        bootstrap: {
          case: 'restore',
          value: {
            sessionCheckpoint: {
              checkpointVersion: checkpoint.checkpointVersion,
              sessionId,
              conversationId: dbSession.conversationId,
              harnessName,
              harnessState: (checkpoint.harnessState ?? {}) as JsonObject,
            },
            agentId: dbSession.agentId,
            harnessConfigJson: JSON.stringify(agentDef.harnessConfig),
            systemPrompt: agentDef.systemPrompt,
            nativeToolPolicy: agentDef.nativeToolPolicy
              ? nativeToolPolicyToProto(agentDef.nativeToolPolicy)
              : undefined,
            tools: restoreTools.map((tool) => create(ToolMetadataSchema, {
              name: tool.name,
              description: tool.description,
              inputSchemaJson: tool.inputSchemaJson,
              location: tool.location,
              programmatic: tool.programmatic ?? false,
            })),
          },
        },
      });

      await performance.measure(
        'harness.open',
        performanceAttributes,
        () => retryGrpcCall(
          () => grpcClient.openSession(openReq, {
            signal: restoreLease.signal,
          }),
          5,
          1000,
          restoreLease.signal,
        ),
      );

      restoreLease.signal.throwIfAborted();
      const completed = await restoreLease.complete({
        containerName: reachableContainerInfo.containerName,
        containerId: reachableContainerInfo.containerId,
      });
      if (!completed) {
        throw new SessionRestoreInProgressError(sessionId);
      }
      createdContainer = undefined;

      const record: SessionRecord = {
        sessionId,
        conversationId: dbSession.conversationId,
        agentId: dbSession.agentId,
        containerName: reachableContainerInfo.containerName,
        containerId: reachableContainerInfo.containerId,
        restoreFenceToken: completed.restoreFenceToken,
        runtimeDefinitionHash: dbSession.runtimeDefinitionHash ?? '',
        status: 'ACTIVE',
        harnessName,
        grpcClient,
        sessionWorkspaceDir,
      };

      this.deps.logger.info(`${TAG} session ${sessionId} restored from checkpoint`);
      return record;
    } catch (err) {
      const outcome = decideRestoreOutcome(err, restoreAttempt);
      // ctx-2mm8: a capacity refusal (full host) must not spend the budget — a
      // healthy checkpoint would otherwise be permanently poisoned by three
      // busy moments. Refund the claim's increment atomically under the fence.
      const isCapacity = outcome.classification.category === 'capacity';
      let failed: SandboxSessionRow | undefined;
      try {
        failed = await restoreLease.fail(
          outcome.toStatus === 'TERMINATED' ? 'TERMINATED' : 'CHECKPOINTED',
          outcome.classification.message,
          isCapacity ? { refundAttempt: true } : undefined,
        );
      } catch (failureError) {
        this.deps.logger.warn(
          `${TAG} could not confirm fenced restore failure for session ${sessionId}:`,
          failureError,
        );
      }
      if (failed) {
        if (createdContainer) {
          await this.rollbackCreatedContainer(sessionId, createdContainer);
        }
        throw err;
      }

      if (createdContainer) {
        const rollbackIsSafe = await this.canRollbackUncommittedRuntime(
          sessionId,
          createdContainer,
        );
        if (rollbackIsSafe) {
          await this.rollbackCreatedContainer(sessionId, createdContainer);
        } else {
          this.deps.logger.warn(
            `${TAG} preserving container ${createdContainer.containerId} for session ${sessionId}: ` +
            'the database may have committed it as the ACTIVE runtime',
          );
        }
      }
      throw new SessionRestoreInProgressError(
        sessionId,
        err,
      );
    } finally {
      await restoreLease.stop();
    }
  }

  /**
   * Restore loop per ADR 013. Tries up to `MAX_RESTORE_ATTEMPTS` total times.
   * Persists attempt count and `last_restore_error` after each failure. Lands
   * the session in `CHECKPOINTED` (retryable budget exhausted) or `TERMINATED`
   * (non-retryable failure) and rethrows the underlying error on final
   * failure.
   */
  async restoreFromCheckpointWithRetry(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
  ): Promise<SessionRecord> {
    const sessionId = dbSession.id;
    const sleep = this.deps.sleep ?? delay;

    let attemptsSoFar = Math.max(0, dbSession.restoreAttempts ?? 0);
    let currentRow = dbSession;
    let lastError: unknown;
    // ctx-2mm8: capacity refusals are refunded, so they are bounded by this
    // local counter rather than the persisted restore budget.
    let capacityRetries = 0;

    while (attemptsSoFar < MAX_RESTORE_ATTEMPTS) {
      const attemptNumber = attemptsSoFar + 1;
      try {
        return await this.restoreFromCheckpointOnce(currentRow, agentDef);
      } catch (err) {
        if (err instanceof WorkspaceSetupError) {
          throw err;
        }
        if (err instanceof LiveSandboxSessionConflictError) {
          const winner = await this.deps.db.getLiveSandboxSessionByConversation(
            currentRow.conversationId,
          );
          if (winner && winner.id !== currentRow.id) {
            this.deps.logger.info(
              `${TAG} joining live session ${winner.id} after losing restore admission for conversation ${currentRow.conversationId}`,
            );
            return this.doRecover(
              currentRow.conversationId,
              agentDef,
              winner.agentId,
              winner,
            );
          }
          throw err;
        }
        const persisted = await this.deps.db.getSandboxSession(sessionId);
        if (!persisted) {
          throw new Error(
            `Sandbox session ${sessionId} disappeared during retry loop`,
            { cause: err },
          );
        }
        if (persisted.status === 'RESTORING') {
          this.deps.logger.info(
            `${TAG} joining session ${sessionId}: another replica owns restore generation ${persisted.restoreFenceToken}`,
          );
          return this.waitForRestoreOutcome(
            persisted,
            persisted.conversationId,
            agentDef,
            persisted.agentId,
          );
        }
        if (
          persisted.status === 'TERMINATED'
        ) {
          throw err instanceof SessionRestoreInProgressError
            && err.cause !== undefined
            ? err.cause
            : err;
        }
        if (persisted.status !== 'CHECKPOINTED') {
          return this.doRecover(
            persisted.conversationId,
            agentDef,
            persisted.agentId,
            persisted,
          );
        }
        lastError = err;
        const classifiedError =
          err instanceof SessionRestoreInProgressError && err.cause !== undefined
            ? err.cause
            : err;

        // ctx-2mm8: capacity refusals refund the attempt, so persisted attempts
        // stay flat and the "not admitted" progress guard below would abort
        // immediately. Pace and bound capacity retries with a local counter
        // instead — the budget was never spent, so this cannot poison a
        // healthy session.
        if (isCapacityError(classifiedError)) {
          capacityRetries += 1;
          if (capacityRetries > RESTORE_BACKOFF_MS.length) {
            this.deps.logger.warn(
              `${TAG} session ${sessionId} restore gave up after ${capacityRetries - 1} capacity refusals`,
            );
            throw classifiedError;
          }
          const delayMs = RESTORE_BACKOFF_MS[capacityRetries - 1];
          this.deps.logger.info(
            `${TAG} session ${sessionId} restore deferred by container capacity `
            + `(refusal ${capacityRetries}); sleeping ${delayMs}ms before retry`,
          );
          await sleep(delayMs);
          const afterCapacity = await this.deps.db.getSandboxSession(sessionId);
          if (!afterCapacity) {
            throw new Error(
              `Sandbox session ${sessionId} disappeared during capacity backoff`,
              { cause: err },
            );
          }
          if (afterCapacity.status !== 'CHECKPOINTED') {
            return this.doRecover(
              afterCapacity.conversationId,
              agentDef,
              afterCapacity.agentId,
              afterCapacity,
            );
          }
          currentRow = afterCapacity;
          continue;
        }

        const persistedAttempts = Math.max(
          0,
          persisted.restoreAttempts ?? 0,
        );
        if (persistedAttempts <= attemptsSoFar) {
          this.deps.logger.warn(
            `${TAG} session ${sessionId} restore was not admitted; ` +
            `persisted attempt count remains ${persistedAttempts}`,
          );
          throw classifiedError;
        }
        attemptsSoFar = persistedAttempts;
        const outcome = decideRestoreOutcome(classifiedError, attemptsSoFar);
        if (
          outcome.toStatus === 'TERMINATED'
          || attemptsSoFar >= MAX_RESTORE_ATTEMPTS
        ) {
          this.deps.logger.warn(
            `${TAG} session ${sessionId} restore stopped after attempt ${attemptsSoFar}: ${outcome.classification.message}`,
          );
          throw classifiedError;
        }

        if (outcome.retryDelayMs && outcome.retryDelayMs > 0) {
          this.deps.logger.info(
            `${TAG} session ${sessionId} retryable restore failure (attempt ${attemptNumber}/${MAX_RESTORE_ATTEMPTS}); sleeping ${outcome.retryDelayMs}ms before retry`,
          );
          await sleep(outcome.retryDelayMs);
        }

        const refreshed = await this.deps.db.getSandboxSession(sessionId);
        if (!refreshed) {
          throw new Error(
            `Sandbox session ${sessionId} disappeared during retry backoff`,
            { cause: err },
          );
        }
        if (refreshed.status !== 'CHECKPOINTED') {
          return this.doRecover(
            refreshed.conversationId,
            agentDef,
            refreshed.agentId,
            refreshed,
          );
        }
        attemptsSoFar = Math.max(
          attemptsSoFar,
          refreshed.restoreAttempts ?? 0,
        );
        currentRow = refreshed;
      }
    }

    // Loop terminated with budget exhausted but not yet persisted as
    // CHECKPOINTED — defensive path.
    if (lastError !== undefined) {
      throw lastError;
    }
    // ctx-2mm8: name budget exhaustion distinctly so the route does not report
    // a generic retryable restore failure for a session that ran out of budget.
    throw new SessionRestoreBudgetExhaustedError(sessionId);
  }

  private async rollbackCreatedContainer(
    sessionId: string,
    container: ContainerInfo,
  ): Promise<void> {
    await stopAndRemoveContainer(
      this.deps.containerManager,
      container.containerId,
      this.deps.logger,
      `${TAG} rollback for newly-created container ${container.containerId} (session ${sessionId})`,
      10,
    );
  }

  /**
   * A failed write may have committed even when its response was lost. Only
   * remove a newly-created runtime after a read proves that the database does
   * not bind that exact container as the ACTIVE generation.
   */
  private async canRollbackUncommittedRuntime(
    sessionId: string,
    container: ContainerInfo,
  ): Promise<boolean> {
    try {
      const current = await this.deps.db.getSandboxSession(sessionId);
      return current?.status !== 'ACTIVE'
        || current.containerId !== container.containerId;
    } catch (readError) {
      this.deps.logger.warn(
        `${TAG} could not verify runtime binding for session ${sessionId}; ` +
        `preserving container ${container.containerId}:`,
        readError,
      );
      return false;
    }
  }

  async recoverDeadSession(
    dbSession: SandboxSessionRow,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    failedOp: string,
    err: unknown,
    recoveryAuthority?: SessionRecoveryAuthority,
  ): Promise<SessionRecord> {
    this.deps.logger.warn(
      `${TAG} ${failedOp} failed for session ${dbSession.id}, attempting recovery`,
      err instanceof Error ? err.message : err,
    );

    const lifecycleOperation = await acquireSandboxSessionLifecycleOperation(
      { db: this.deps.db, logger: this.deps.logger },
      dbSession.id,
      'reset',
      {
        expectedActiveGeneration: {
          restoreFenceToken: dbSession.restoreFenceToken,
          containerId: dbSession.containerId,
        },
        ...(recoveryAuthority
          ? {
            allowedTurnDelivery: {
              turnId: recoveryAuthority.turnId,
              fence: recoveryAuthority.fence,
              interruptResumeAttemptId: recoveryAuthority.attemptId,
            },
          }
          : {}),
      },
    );
    if (!lifecycleOperation || lifecycleOperation.operation !== 'reset') {
      await lifecycleOperation?.stop();
      const winner = await this.recoverCompetingLiveSession(
        dbSession,
        conversationId,
        agentDef,
        agentId,
      );
      if (winner) {
        return winner;
      }
      throw new SessionRecoveryConflictError(dbSession.id);
    }

    if (!await lifecycleOperation.markExecuting()) {
      await lifecycleOperation.cancel();
      const winner = await this.recoverCompetingLiveSession(
        dbSession,
        conversationId,
        agentDef,
        agentId,
      );
      if (winner) {
        return winner;
      }
      throw new SessionRecoveryConflictError(dbSession.id);
    }

    try {
      lifecycleOperation.signal.throwIfAborted();
      const checkpoint = await this.deps.db.getCheckpointV2(dbSession.id);
      lifecycleOperation.signal.throwIfAborted();
      const resultingStatus = checkpoint ? 'CHECKPOINTED' : 'TERMINATED';
      const failureMessage = err instanceof Error ? err.message : String(err);
      const deadRuntimeContainerId = await this.resolveDeadRuntimeContainerId(
        dbSession,
      );
      lifecycleOperation.signal.throwIfAborted();
      await this.cleanupDeadRuntime(
        dbSession,
        agentDef,
        deadRuntimeContainerId,
      );
      lifecycleOperation.signal.throwIfAborted();
      await this.deps.statusCoordinator.transition({
        sessionId: dbSession.id,
        fromStatus: 'ACTIVE',
        toStatus: resultingStatus,
        clearRuntime: true,
        extra: {
          lastRestoreError: `${failedOp} failed: ${failureMessage}`,
        },
        lifecycleOperation: lifecycleOperation.fence,
      });
      await lifecycleOperation.stop();

      if (checkpoint) {
        this.deps.logger.info(
          `${TAG} checkpoint found for session ${dbSession.id}, restoring from checkpoint`,
        );
        const record = await this.restoreFromCheckpoint({
          ...dbSession,
          status: 'CHECKPOINTED',
          containerId: null,
          containerName: null,
        }, agentDef);
        this.deps.stateStore.setSession(conversationId, record);
        return record;
      }

      this.deps.logger.warn(
        `${TAG} no checkpoint for session ${dbSession.id}, creating fresh session`,
      );
      return this.createFreshOrJoinLiveSession(
        conversationId,
        agentDef,
        agentId,
      );
    } finally {
      await lifecycleOperation.stop();
    }
  }

  isStaleContainerError(err: unknown): boolean {
    return SessionRecoveryCoordinator.isStaleContainerError(err);
  }

  static isStaleContainerError(err: unknown): boolean {
    if (err instanceof ConnectError && err.code === Code.Unavailable) {
      return true;
    }
    if (err instanceof Error && TRANSPORT_ERROR_RE.test(err.message)) {
      return true;
    }
    return false;
  }

  async reconcileExpiredSandboxSessionRestore(
    dbSession: SandboxSessionRow,
  ): Promise<'CHECKPOINTED' | 'TERMINATED' | undefined> {
    const sessionId = dbSession.id;
    const reconciled =
      await this.deps.db.reconcileExpiredSandboxSessionRestore(
        sessionId,
        dbSession.restoreFenceToken,
      );
    if (!reconciled) {
      this.deps.logger.debug(
        `${TAG} restore generation ${dbSession.restoreFenceToken} for session ${sessionId} is no longer expired/current`,
      );
      return undefined;
    }

    this.deps.logger.warn(
      `${TAG} fenced expired restore generation ${dbSession.restoreFenceToken} for session ${sessionId} -> ${reconciled.outcome}`,
    );
    return reconciled.outcome;
  }

  private async doRecover(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    dbSession: SandboxSessionRow,
    recoveryAuthority?: SessionRecoveryAuthority,
  ): Promise<SessionRecord> {
    switch (dbSession.status) {
      case 'ACTIVE': {
        try {
          return await this.reconnectToContainer(dbSession, agentDef);
        } catch (err) {
          if (err instanceof WorkspaceSetupError) {
            throw err;
          }
          return this.recoverDeadSession(
            dbSession,
            conversationId,
            agentDef,
            agentId,
            'reconnect',
            err,
            recoveryAuthority,
          );
        }
      }
      case 'CHECKPOINTED':
        return this.restoreFromCheckpoint(dbSession, agentDef);
      case 'RESTORING': {
        // RESTORING is a live cross-replica state. Ordinary requests join the
        // worker that owns it; only the lifecycle reconciler may classify an
        // old row as stranded and demote it.
        return this.waitForRestoreOutcome(
          dbSession,
          conversationId,
          agentDef,
          agentId,
        );
      }
      case 'TERMINATED':
        this.deps.logger.info(
          `${TAG} session ${dbSession.id} for conversation ${conversationId} is terminated, creating fresh session`,
        );
        return this.createFreshOrJoinLiveSession(
          conversationId,
          agentDef,
          agentId,
        );
      default:
        this.deps.logger.warn(
          `${TAG} unknown status '${dbSession.status}' for session ${dbSession.id}, creating fresh session`,
        );
        return this.createFreshOrJoinLiveSession(
          conversationId,
          agentDef,
          agentId,
        );
    }
  }

  private async resolveDeadRuntimeContainerId(
    dbSession: SandboxSessionRow,
  ): Promise<string | null> {
    try {
      const runtimeContainer = await this.deps.containerManager.getContainer(
        dbSession.id,
      );
      return runtimeContainer?.containerId ?? dbSession.containerId;
    } catch (error) {
      this.deps.logger.warn(
        `${TAG} failed to inspect dead container for session ${dbSession.id}:`,
        error,
      );
      return dbSession.containerId;
    }
  }

  private async cleanupDeadRuntime(
    dbSession: SandboxSessionRow,
    agentDef: AgentDefinition,
    containerId: string | null,
  ): Promise<void> {
    const cached = this.deps.stateStore.getSessionByConversation(
      dbSession.conversationId,
    );
    if (!cached || cached.sessionId === dbSession.id) {
      this.deps.stateStore.cleanupSession(
        dbSession.id,
        dbSession.conversationId,
      );
      this.deps.stateStore.setAgentDef(dbSession.conversationId, agentDef);
    }

    if (containerId) {
      await stopAndRemoveContainer(
        this.deps.containerManager,
        containerId,
        this.deps.logger,
        `${TAG} dead-session cleanup for ${dbSession.id}`,
        10,
      );
    }
  }

  private async waitForRestoreOutcome(
    restoringSession: SandboxSessionRow,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
  ): Promise<SessionRecord> {
    const sleep = this.deps.sleep ?? delay;
    for (let poll = 0; poll < RESTORE_JOIN_MAX_POLLS; poll += 1) {
      const current = await this.deps.db.getSandboxSession(
        restoringSession.id,
      );
      if (current?.status === 'RESTORING') {
        const reconciled =
          await this.deps.db.reconcileExpiredSandboxSessionRestore(
            current.id,
            current.restoreFenceToken,
          );
        if (reconciled) {
          return this.doRecover(
            conversationId,
            agentDef,
            agentId ?? reconciled.session.agentId,
            reconciled.session,
          );
        }
      }
      if (current && current.status !== 'RESTORING') {
        return this.doRecover(
          conversationId,
          agentDef,
          agentId ?? current.agentId,
          current,
        );
      }
      if (!current) {
        const winner = await this.deps.db.getLiveSandboxSessionByConversation(
          conversationId,
        );
        if (winner) {
          return this.doRecover(
            conversationId,
            agentDef,
            agentId ?? winner.agentId,
            winner,
          );
        }
        throw new Error(
          `Sandbox session ${restoringSession.id} disappeared during restore`,
        );
      }
      if (poll + 1 < RESTORE_JOIN_MAX_POLLS) {
        await sleep(RESTORE_JOIN_POLL_MS);
      }
    }
    throw new SessionRestoreInProgressError(restoringSession.id);
  }

  private async createFreshOrJoinLiveSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
  ): Promise<SessionRecord> {
    try {
      return await this.deps.createFreshSession(
        conversationId,
        agentDef,
        agentId,
      );
    } catch (error) {
      if (!(error instanceof LiveSandboxSessionConflictError)) {
        throw error;
      }

      const winner = await this.deps.db.getLiveSandboxSessionByConversation(
        conversationId,
      );
      if (!winner) {
        throw error;
      }
      this.deps.logger.info(
        `${TAG} joining live session ${winner.id} after losing replacement race for conversation ${conversationId}`,
      );
      return this.doRecover(
        conversationId,
        agentDef,
        agentId ?? winner.agentId,
        winner,
      );
    }
  }

  private async recoverCompetingLiveSession(
    previous: SandboxSessionRow,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
  ): Promise<SessionRecord | undefined> {
    const winner = await this.deps.db.getLiveSandboxSessionByConversation(
      conversationId,
    );
    if (!winner || winner.id === previous.id) {
      return undefined;
    }
    this.deps.logger.info(
      `${TAG} joining competing recovery session ${winner.id} for conversation ${conversationId}`,
    );
    return this.doRecover(
      conversationId,
      agentDef,
      agentId ?? winner.agentId,
      winner,
    );
  }

  private isSessionRecord(value: HarnessGrpcClient | SessionRecord | undefined): value is SessionRecord {
    return typeof value === 'object'
      && value !== null
      && 'sessionId' in value
      && typeof value.sessionId === 'string';
  }
}
