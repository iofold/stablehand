import type { SessionCheckpoint } from '@ctxmill/proto/sandbox/v1';

import type { CheckpointV2, SandboxSessionRow } from '../../database/repository.js';
import type { AgentDefinition, Message } from '../../types.js';
import type { SessionEvent } from '../session-turn-service.js';
import type { HarnessGrpcClient, SessionRecord, TurnQueueEntry } from './types.js';

export interface SessionTurnPort {
  ensureSession(
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string,
  ): Promise<{ sessionId: string }>;
  deliverTurn(sessionId: string, messages: Message[], turnId: string): AsyncGenerator<SessionEvent>;
}

export interface SessionAdminPort {
  getSession(conversationId: string): Promise<SessionRecord | null>;
  getActiveSessions(): Promise<SessionRecord[]>;
  getSessionsByAgent(agentId: string): Promise<SessionRecord[]>;
  suspendSession(sessionId: string, reason: string): Promise<SessionCheckpoint>;
  killSession(sessionId: string): Promise<void>;
}

export interface SessionReconciler {
  onSessionReconnected(session: SandboxSessionRow, grpcClient?: HarnessGrpcClient): void;
  onSessionEvicted(sessionId: string, conversationId: string): void | Promise<void>;
  recoverDeadSession?(
    session: SandboxSessionRow,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string | undefined,
    failedOp: string,
    err: unknown,
  ): Promise<SessionRecord>;
}

export interface InterruptResumePort {
  resumeWithInterruptResolution(sessionId: string, turnId: string, agentId: string): Promise<void>;
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
  registerTurnController(sessionId: string, turnId: string, controller: AbortController): void;
  getTurnAbortSignal(sessionId: string, turnId: string): AbortSignal | undefined;
  abortTurn(sessionId: string, turnId: string): boolean;
  clearTurnController(sessionId: string, turnId: string): void;
  cleanupSession(sessionId: string, conversationId: string): void;
  getCheckpoint?(sessionId: string): Promise<CheckpointV2 | null>;
  withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>;
}
