import type { AgentDefinition, Message } from '../types.js';
import type { SessionEvent as CustomSessionEvent } from './session-turn-service.js';
import { buildAgentDefinition } from './agent-definition.js';
import { TurnFinalizer } from './turn-finalizer.js';
import { InterruptResumeService } from './session-manager/interrupt-resume-service.js';
import { SessionLifecycleService } from './session-manager/session-lifecycle-service.js';
import type { SuspendSessionOptions } from './session-manager/session-lifecycle-service.js';
import type { SessionReconciler } from './session-manager/ports.js';
import { SessionRecoveryCoordinator } from './session-manager/session-recovery-coordinator.js';
import { SessionRuntimeFactory } from './session-manager/session-runtime-factory.js';
import { SessionStatusCoordinator } from './session-manager/session-status-coordinator.js';
import { SessionStateStore } from './session-manager/session-state-store.js';
import {
  SessionTurnOrchestrator,
  type ConcurrencyReservation,
  type SessionTurnStartOptions,
} from './session-manager/session-turn-orchestrator.js';
import type { SandboxSessionManagerDeps, SessionRecord } from './session-manager/types.js';

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
    this.stateStore = deps.stateStore;
    this.statusCoordinator = deps.statusCoordinator;
    this.runtimeFactory = new SessionRuntimeFactory({
      containerManager: deps.containerManager,
      db: deps.db,
      buildSandboxSecrets: deps.buildSandboxSecrets,
      resolveToolsForAgent: deps.resolveToolsForAgent ?? (() => []),
      checkConcurrencyLimit: (agentId, options) => this.turnOrchestrator.checkConcurrencyLimit(agentId, options),
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
      onStaleContainer: (_sessionId, conversationId, agentDef, agentId) =>
        this.ensureSession(conversationId, agentDef, agentId),
      onSessionRebound: async ({ turnId, sessionId }) => {
        await deps.db.updateTurn(turnId, { sessionId });
      },
      onTurnActive: async (turnId) => {
        await deps.db.updateTurn(turnId, { status: 'running' });
      },
      executeDeliverTurn: (sessionId, messages, turnId, onSessionRebound) =>
        this.executeDeliverTurn(sessionId, messages, turnId, false, onSessionRebound),
    });
    const turnFinalizer = new TurnFinalizer({ db: deps.db, eventBus: deps.eventBus, logger: deps.logger });
    this.interruptResumeService = new InterruptResumeService({
      db: deps.db,
      stateStore: this.stateStore,
      logger: deps.logger,
      ensureSession: (conversationId, agentDef, agentId) => this.ensureSession(conversationId, agentDef, agentId),
      deliverTurn: (sessionId, messages, turnId) => this.deliverTurn(sessionId, messages, turnId),
      resolveAgentDefinition: async (agentId) => {
        const agent = await deps.db.getAgent(agentId);
        return agent ? buildAgentDefinition(agent) : null;
      },
      finalizeOriginalTurn: async (turnId, agentId, conversationId) => {
        await turnFinalizer.finalize({ turnId, agentId, conversationId, status: 'completed' });
      },
    });
    this.lifecycleService = new SessionLifecycleService({
      stateStore: this.stateStore,
      recoveryCoordinator: this.recoveryCoordinator,
      createFreshSession: (conversationId, agentDef, agentId) => this.createFreshSession(conversationId, agentDef, agentId),
      db: deps.db,
      statusCoordinator: this.statusCoordinator,
      containerManager: deps.containerManager,
      lifecyclePolicy: deps.lifecyclePolicy,
      workspaceDiffService: deps.workspaceDiffService,
      logger: deps.logger,
      parsePendingRequestPayload: (payloadJson) => this.parsePendingRequestPayload(payloadJson),
    });
  }

  ensureSession(conversationId: string, agentDef: AgentDefinition, agentId?: string, options?: { concurrencyReservationId?: string }) { return this.lifecycleService.ensureSession(conversationId, agentDef, agentId, options); }
  getSessionReconciler(): SessionReconciler { return this.lifecycleService.getSessionReconciler(); }
  onSessionReconnected(conversationId: string, record: SessionRecord): void { this.lifecycleService.onSessionReconnected(conversationId, record); }
  async onSessionEvicted(sessionId: string, conversationId: string): Promise<void> { await this.lifecycleService.onSessionEvicted(sessionId, conversationId); }
  startTurn(sessionId: string, turnId: string, agentId: string, conversationId: string, mode: 'interactive' | 'background', taskDescription?: string, options?: SessionTurnStartOptions): AbortSignal { return this.turnOrchestrator.startTurn(sessionId, turnId, agentId, conversationId, mode, taskDescription, options); }
  completeTurn(sessionId: string, turnId: string, agentId: string, conversationId: string, status: 'completed' | 'error' | 'cancelled', durationMs: number, error?: string): void { this.turnOrchestrator.completeTurn(sessionId, turnId, agentId, conversationId, status, durationMs, error); }
  cancelCurrentTurn(sessionId: string, turnId?: string): boolean { return this.turnOrchestrator.cancelCurrentTurn(sessionId, turnId); }
  getAbortSignal(sessionId: string, turnId?: string): AbortSignal | undefined { return this.turnOrchestrator.getAbortSignal(sessionId, turnId); }
  checkConcurrencyLimit(agentId: string): void { this.turnOrchestrator.checkConcurrencyLimit(agentId); }
  reserveConcurrencySlot(agentId: string): ConcurrencyReservation { return this.turnOrchestrator.reserveConcurrencySlot(agentId); }
  async *deliverTurn(sessionId: string, messages: Message[], turnId: string): AsyncGenerator<CustomSessionEvent> { yield* this.turnOrchestrator.deliverTurn(sessionId, messages, turnId); }
  suspendSession(sessionId: string, reason: string, options?: SuspendSessionOptions) { return this.lifecycleService.suspendSession(sessionId, reason, options); }
  restoreSession(sessionId: string, agentDef: AgentDefinition, agentId?: string) { return this.lifecycleService.restoreSession(sessionId, agentDef, agentId); }
  startRestoreSession(sessionId: string, agentDef: AgentDefinition, agentId?: string) { return this.lifecycleService.startRestoreSession(sessionId, agentDef, agentId); }
  killSession(sessionId: string) { return this.lifecycleService.killSession(sessionId); }
  resumeWithInterruptResolution(sessionId: string, turnId: string, agentId: string): Promise<void> { return this.interruptResumeService.resumeWithInterruptResolution(sessionId, turnId, agentId); }
  getSession(conversationId: string) { return this.lifecycleService.getSession(conversationId); }
  getActiveSessions() { return this.lifecycleService.getActiveSessions(); }
  getSessionsByAgent(agentId: string) { return this.lifecycleService.getSessionsByAgent(agentId); }
  reconcileStrandedRestoringSessions(updatedBeforeMs?: number) {
    return this.lifecycleService.reconcileStrandedRestoringSessions(updatedBeforeMs);
  }
  createFreshSession(conversationId: string, agentDef: AgentDefinition, agentId?: string, options?: { concurrencyReservationId?: string }) { return this.runtimeFactory.createFreshSession(conversationId, agentDef, agentId, options); }
  getExistingConversationWorkspaceDir(agentId: string, conversationId: string) { return this.runtimeFactory.getExistingConversationWorkspaceDir(agentId, conversationId); }
  parsePendingRequestPayload(payloadJson: string) { return this.interruptResumeService.parsePendingRequestPayload(payloadJson); }
  async *executeDeliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
    retried = false,
    onSessionRebound?: (nextSessionId: string) => void,
  ): AsyncGenerator<CustomSessionEvent> {
    yield* this.turnOrchestrator.executeDeliverTurn(sessionId, messages, turnId, retried, onSessionRebound);
  }
  drainCoalescedQueue(sessionId: string): Promise<void> { return this.turnOrchestrator.drainCoalescedQueue(sessionId); }
  findSessionById(sessionId: string): SessionRecord | undefined { return this.lifecycleService.findSessionById(sessionId); }
  getActiveTurnId(sessionId: string): string | undefined { return this.lifecycleService.getActiveTurnId(sessionId); }
  isStaleContainerError(err: unknown): boolean { return SessionRecoveryCoordinator.isStaleContainerError(err); }
}
