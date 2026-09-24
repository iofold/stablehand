import type { CheckpointV2, SandboxSessionRow } from '../../database/repository.js';
import type { AgentDefinition } from '@stablehand/sandbox-daemon';
import type {
  HarnessGrpcClient,
  SessionRecord,
  SessionRecoveryAuthority,
  TurnQueueEntry,
} from './types.js';

export interface SessionReconnectionRegistration {
  revoke(): void | Promise<void>;
}

export interface SessionReconciler {
  onSessionReconnected(
    session: SandboxSessionRow,
    grpcClient?: HarnessGrpcClient,
  ): SessionReconnectionRegistration;
  onSessionEvicted(sessionId: string, conversationId: string): void | Promise<void>;
  reconcileExpiredSandboxSessionRestore(
    session: SandboxSessionRow,
  ): Promise<'CHECKPOINTED' | 'TERMINATED' | undefined>;
  recoverDeadSession?(
    session: SandboxSessionRow,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    failedOp: string,
    err: unknown,
    recoveryAuthority?: SessionRecoveryAuthority,
  ): Promise<SessionRecord>;
}

export interface SessionStatePort {
  getSessionByConversation(conversationId: string): SessionRecord | undefined;
  getSessionById(sessionId: string): SessionRecord | undefined;
  setSession(conversationId: string, record: SessionRecord): void;
  deleteSession(conversationId: string): void;
  getAllSessions(): SessionRecord[];
  getSessionsByAgent(agentId: string): SessionRecord[];
  getAgentDef(conversationId: string): AgentDefinition | undefined;
  setAgentDef(conversationId: string, def: AgentDefinition): void;
  deleteAgentDef(conversationId: string): void;
  getQueue(sessionId: string): TurnQueueEntry[] | undefined;
  getOrCreateQueue(sessionId: string): TurnQueueEntry[];
  deleteQueue(sessionId: string): void;
  isActiveTurn(sessionId: string): boolean;
  getActiveTurnId(sessionId: string): string | undefined;
  markTurnActive(sessionId: string, turnId: string): void;
  markTurnInactive(sessionId: string, turnId?: string): void;
  rebindTurnRuntime(previousSessionId: string, nextSessionId: string, turnId: string): void;
  registerTurnController(sessionId: string, turnId: string, controller: AbortController): void;
  getTurnAbortSignal(sessionId: string, turnId: string): AbortSignal | undefined;
  abortTurn(sessionId: string, turnId: string): boolean;
  clearTurnController(sessionId: string, turnId: string): void;
  cleanupSession(sessionId: string, conversationId: string): void;
  getCheckpoint?(sessionId: string): Promise<CheckpointV2 | null>;
  withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>;
}
