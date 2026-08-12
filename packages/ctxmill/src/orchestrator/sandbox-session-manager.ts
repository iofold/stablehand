import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { SessionEvent as CustomSessionEvent } from './session-turn-service.js';
import { buildAgentDefinition } from './agent-definition.js';
import { InterruptResumeService } from './session-manager/interrupt-resume-service.js';
import type {
  PreparedInterruptContinuation,
  PreparedInterruptContinuationReady,
} from './session-manager/interrupt-resume-service.js';
import { SessionLifecycleService } from './session-manager/session-lifecycle-service.js';
import type {
  KillSessionOptions,
  RestoreSessionStart,
  SuspendSessionOptions,
} from './session-manager/session-lifecycle-service.js';
import type {
  SessionReconnectionRegistration,
  SessionReconciler,
} from './session-manager/ports.js';
import { SessionRecoveryCoordinator } from './session-manager/session-recovery-coordinator.js';
import { SessionRuntimeFactory } from './session-manager/session-runtime-factory.js';
import { SessionStatusCoordinator } from './session-manager/session-status-coordinator.js';
import { SessionStateStore } from './session-manager/session-state-store.js';
import {
  SessionTurnOrchestrator,
  type ConcurrencyReservation,
  type SessionTurnStartOptions,
} from './session-manager/session-turn-orchestrator.js';
import type {
  SandboxSessionManagerDeps,
  SessionEnsureOptions,
  SessionRecord,
  TurnDeliveryOptions,
} from './session-manager/types.js';
import type { TurnDeliveryFence } from './turn-delivery-fence.js';
import { resolveGrpcCallbackAuthConfig } from './grpc/callback-auth.js';
import { mintTurnDeliveryCapability } from './grpc/turn-delivery-capability.js';

export type { Logger, SessionRecord } from './session-manager/types.js';
export type { SandboxSessionManagerDeps, ToolMetadata } from './session-manager/types.js';

export class SandboxSessionManager {
  readonly stateStore: SessionStateStore;
  private readonly lifecycleService: SessionLifecycleService;
  private readonly interruptResumeService: InterruptResumeService;
  private readonly logger: SandboxSessionManagerDeps['logger'];
  private readonly recoveryCoordinator: SessionRecoveryCoordinator;
  private readonly runtimeFactory: SessionRuntimeFactory;
  private readonly statusCoordinator: SessionStatusCoordinator;
  private readonly turnOrchestrator: SessionTurnOrchestrator;

  constructor(deps: SandboxSessionManagerDeps) {
    this.logger = deps.logger;
    const resolveRuntimeDefinitionHash = deps.resolveRuntimeDefinitionHash
      ?? (async () => '');
    const callbackAuthConfig = resolveGrpcCallbackAuthConfig(
      process.env,
      { warn: () => undefined },
    );
    this.stateStore = deps.stateStore;
    this.statusCoordinator = deps.statusCoordinator;
    this.runtimeFactory = new SessionRuntimeFactory({
      containerManager: deps.containerManager,
      db: deps.db,
      buildSandboxSecrets: deps.buildSandboxSecrets,
      resolveToolsForAgent: deps.resolveToolsForAgent ?? (() => []),
      checkConcurrencyLimit: (agentId, options) => this.turnOrchestrator.checkConcurrencyLimit(agentId, options),
      resolveRuntimeDefinitionHash,
      logger: deps.logger,
      dataDir: deps.dataDir,
    });
    this.recoveryCoordinator = new SessionRecoveryCoordinator({
      containerManager: deps.containerManager,
      db: deps.db,
      statusCoordinator: this.statusCoordinator,
      stateStore: this.stateStore,
      buildSandboxSecrets: deps.buildSandboxSecrets,
      resolveToolsForAgent: deps.resolveToolsForAgent ?? (() => []),
      workspaceDiffService: deps.workspaceDiffService,
      logger: deps.logger,
      createFreshSession: (conversationId, agentDef, agentId, options) =>
        this.createFreshSession(conversationId, agentDef, agentId, options),
      getExistingConversationWorkspaceDir: (agentId, conversationId) =>
        this.getExistingConversationWorkspaceDir(agentId, conversationId),
      onActiveSessionReconnected: (record) => {
        this.turnOrchestrator.scheduleIdleTimeoutForActiveSession(record.sessionId, record, { resumeFromLastActivity: true });
        return {
          revoke: () => deps.lifecyclePolicy.cancelIdleTimeout(
            record.sessionId,
          ),
        };
      },
    });
    this.turnOrchestrator = new SessionTurnOrchestrator({
      stateStore: this.stateStore,
      statusCoordinator: this.statusCoordinator,
      lifecyclePolicy: deps.lifecyclePolicy,
      eventBus: deps.eventBus,
      interruptManager: deps.interruptManager,
      logger: deps.logger,
      config: {
        maxQueuedMessages: deps.config.maxQueuedMessages,
        turnTimeoutMs: deps.config.turnTimeoutMs,
        maxConcurrentSessionsPerAgent: deps.maxConcurrentSessionsPerAgent ?? 3,
      },
      onCheckpoint: async (sessionId) => {
        await this.suspendSession(sessionId, 'idle-checkpoint');
      },
      reserveSessionReset: ({ turnId, sessionId, deliveryFence }) =>
        this.lifecycleService.reserveSessionReset(
          sessionId,
          turnId,
          deliveryFence,
        ),
      executeReservedSessionReset: (sessionId, lifecycleOperation) =>
        this.lifecycleService.executeReservedSessionReset(
          sessionId,
          lifecycleOperation,
        ),
      resetSession: (sessionId) => this.lifecycleService.resetSession(sessionId),
      onTurnActive: async ({
        turnId,
        sessionId,
        deliveryFence,
        expectedActiveGeneration,
      }) => {
        if (deliveryFence) {
          return deps.db.activateTurnDelivery({
            turnId,
            sandboxSessionId: sessionId,
            ownerId: deliveryFence.ownerId,
            fenceToken: deliveryFence.fenceToken,
            expectedActiveGeneration,
          });
        }
        return deps.db.activateTurnIfOpen(
          turnId,
          sessionId,
          expectedActiveGeneration,
        );
      },
      verifyActiveGeneration: (sessionId, expectedActiveGeneration) =>
        deps.db.isSandboxSessionActiveGenerationCurrent(
          sessionId,
          expectedActiveGeneration,
        ),
      verifyTurnDeliveryFence: (turnId, fence) =>
        deps.db.isTurnDeliveryFenceCurrent(turnId, fence),
      issueTurnDeliveryCapability: async (input) => {
        const claims = await deps.db.getTurnDeliveryCapabilityClaims(input);
        if (!claims) {
          return undefined;
        }
        return mintTurnDeliveryCapability({
          turnId: claims.turnId,
          sandboxSessionId: claims.sandboxSessionId,
          agentId: claims.agentId,
          ownerId: claims.ownerId,
          fenceToken: claims.fenceToken,
          leaseExpiresAtMs: claims.leaseExpiresAtMs,
          restoreFenceToken: claims.restoreFenceToken,
          ...(claims.containerId === null
            ? {}
            : { containerId: claims.containerId }),
        }, callbackAuthConfig);
      },
      executeDeliverTurn: (sessionId, messages, turnId, options) =>
        this.executeDeliverTurn(
          sessionId,
          messages,
          turnId,
          options,
        ),
    });
    this.interruptResumeService = new InterruptResumeService({
      db: deps.db,
      eventBus: deps.eventBus,
      stateStore: this.stateStore,
      logger: deps.logger,
      ensureSession: (conversationId, agentDef, agentId, options) =>
        this.ensureSession(conversationId, agentDef, agentId, options),
      executeContinuation: async (input) => {
        if (!deps.executeInterruptContinuation) {
          throw new Error(
            'Interrupt continuation execution is not configured',
          );
        }
        await deps.executeInterruptContinuation(input);
      },
      resolveTurnSecrets: async (turnId) => {
        return deps.resolveTurnSecrets(turnId);
      },
      resolveAgentDefinition: async (agentId) => {
        const agent = await deps.db.getAgent(agentId);
        return agent ? buildAgentDefinition(agent) : null;
      },
    });
    this.lifecycleService = new SessionLifecycleService({
      stateStore: this.stateStore,
      recoveryCoordinator: this.recoveryCoordinator,
      createFreshSession: (conversationId, agentDef, agentId, options) =>
        this.createFreshSession(
          conversationId,
          agentDef,
          agentId,
          options,
        ),
      resolveRuntimeDefinitionHash,
      db: deps.db,
      statusCoordinator: this.statusCoordinator,
      containerManager: deps.containerManager,
      lifecyclePolicy: deps.lifecyclePolicy,
      workspaceDiffService: deps.workspaceDiffService,
      logger: deps.logger,
      parsePendingRequestPayload: (payloadJson) => this.parsePendingRequestPayload(payloadJson),
    });
  }

  ensureSession(conversationId: string, agentDef: AgentDefinition, agentId?: string, options?: SessionEnsureOptions) { return this.lifecycleService.ensureSession(conversationId, agentDef, agentId, options); }
  getSessionReconciler(): SessionReconciler { return this.lifecycleService.getSessionReconciler(); }
  onSessionReconnected(
    conversationId: string,
    record: SessionRecord,
  ): SessionReconnectionRegistration {
    return this.lifecycleService.onSessionReconnected(
      conversationId,
      record,
    );
  }
  async onSessionEvicted(sessionId: string, conversationId: string): Promise<void> { await this.lifecycleService.onSessionEvicted(sessionId, conversationId); }
  startTurn(sessionId: string, turnId: string, agentId: string, conversationId: string, mode: 'interactive' | 'background', taskDescription?: string, options?: SessionTurnStartOptions): AbortSignal { return this.turnOrchestrator.startTurn(sessionId, turnId, agentId, conversationId, mode, taskDescription, options); }
  completeTurn(sessionId: string, turnId: string, agentId: string, conversationId: string, status: 'completed' | 'error' | 'cancelled', durationMs: number, error?: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number }): Promise<void> { return this.turnOrchestrator.completeTurn(sessionId, turnId, agentId, conversationId, status, durationMs, error, usage); }
  abandonTurnDelivery(sessionId: string, turnId: string): Promise<void> { return this.turnOrchestrator.abandonTurnDelivery(sessionId, turnId); }
  getPendingSessionReset(turnId: string) { return this.turnOrchestrator.getPendingSessionReset(turnId); }
  getTurnDeliveryFence(turnId: string): TurnDeliveryFence | undefined { return this.turnOrchestrator.getTurnDeliveryFence(turnId); }
  cancelCurrentTurn(sessionId: string, turnId?: string): boolean { return this.turnOrchestrator.cancelCurrentTurn(sessionId, turnId); }
  getAbortSignal(sessionId: string, turnId?: string): AbortSignal | undefined { return this.turnOrchestrator.getAbortSignal(sessionId, turnId); }
  checkConcurrencyLimit(agentId: string): void { this.turnOrchestrator.checkConcurrencyLimit(agentId); }
  reserveConcurrencySlot(agentId: string): ConcurrencyReservation { return this.turnOrchestrator.reserveConcurrencySlot(agentId); }
  async *deliverTurn(sessionId: string, messages: Message[], turnId: string, options?: TurnDeliveryOptions): AsyncGenerator<CustomSessionEvent> { yield* this.turnOrchestrator.deliverTurn(sessionId, messages, turnId, options); }
  suspendSession(sessionId: string, reason: string, options?: SuspendSessionOptions) { return this.lifecycleService.suspendSession(sessionId, reason, options); }
  restoreSession(sessionId: string, agentDef: AgentDefinition, agentId?: string): Promise<SessionRecord>;
  restoreSession(sessionId: string, agentDef: AgentDefinition, agentId: string | undefined, options: { background: true }): Promise<RestoreSessionStart>;
  restoreSession(sessionId: string, agentDef: AgentDefinition, agentId?: string, options?: { background?: boolean }) {
    if (options?.background) {
      return this.lifecycleService.restoreSession(sessionId, agentDef, agentId, { background: true });
    }
    return this.lifecycleService.restoreSession(sessionId, agentDef, agentId);
  }
  killSession(sessionId: string, options?: KillSessionOptions) {
    return this.lifecycleService.killSession(sessionId, options);
  }
  prepareInterruptContinuation(
    sessionId: string,
    turnId: string,
    agentId: string,
    interruptId: string,
    recoveryAuthority?: { attemptId: string; fence: TurnDeliveryFence },
  ): Promise<PreparedInterruptContinuation> {
    return this.interruptResumeService.prepareInterruptContinuation(
      sessionId,
      turnId,
      agentId,
      interruptId,
      recoveryAuthority,
    );
  }
  executeInterruptContinuation(prepared: PreparedInterruptContinuationReady, attemptId: string, fence: TurnDeliveryFence, signal?: AbortSignal): Promise<void> { return this.interruptResumeService.executeInterruptContinuation(prepared, attemptId, fence, signal); }
  getSession(conversationId: string) { return this.lifecycleService.getSession(conversationId); }
  getActiveSessions() { return this.lifecycleService.getActiveSessions(); }
  getSessionsByAgent(agentId: string) { return this.lifecycleService.getSessionsByAgent(agentId); }
  createFreshSession(conversationId: string, agentDef: AgentDefinition, agentId?: string, options?: { concurrencyReservationId?: string; runtimeDefinitionHash?: string }) { return this.runtimeFactory.createFreshSession(conversationId, agentDef, agentId, options); }
  getExistingConversationWorkspaceDir(agentId: string, conversationId: string) { return this.runtimeFactory.getExistingConversationWorkspaceDir(agentId, conversationId); }
  parsePendingRequestPayload(payloadJson: string) { return this.interruptResumeService.parsePendingRequestPayload(payloadJson); }
  async *executeDeliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
    options?: TurnDeliveryOptions,
  ): AsyncGenerator<CustomSessionEvent> {
    yield* this.turnOrchestrator.executeDeliverTurn(
      sessionId,
      messages,
      turnId,
      options,
    );
  }
  drainCoalescedQueue(sessionId: string): Promise<void> { return this.turnOrchestrator.drainCoalescedQueue(sessionId); }
  findSessionById(sessionId: string): SessionRecord | undefined { return this.lifecycleService.findSessionById(sessionId); }
  getActiveTurnId(sessionId: string): string | undefined { return this.lifecycleService.getActiveTurnId(sessionId); }
  isStaleContainerError(err: unknown): boolean { return SessionRecoveryCoordinator.isStaleContainerError(err); }
}
