import type { AgentDefinition } from '../../types.js';
import type { SessionStatePort } from './ports.js';
import type { SessionRecord, TurnQueueEntry } from './types.js';

export class SessionStateStore implements SessionStatePort {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionsById = new Map<string, SessionRecord>();

  private readonly turnQueues = new Map<string, TurnQueueEntry[]>();

  private readonly activeTurns = new Set<string>();

  private readonly agentDefs = new Map<string, AgentDefinition>();

  private readonly conversationLocks = new Map<string, Promise<void>>();

  getSessionByConversation(conversationId: string): SessionRecord | undefined {
    return this.sessions.get(conversationId);
  }

  getSessionById(sessionId: string): SessionRecord | undefined {
    const indexed = this.sessionsById.get(sessionId);
    if (indexed) {
      return indexed;
    }

    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) {
        this.sessionsById.set(sessionId, record);
        return record;
      }
    }

    return undefined;
  }

  setSession(conversationId: string, record: SessionRecord): void {
    const existing = this.sessions.get(conversationId);
    if (existing && existing.sessionId !== record.sessionId) {
      this.sessionsById.delete(existing.sessionId);
    }
    this.sessions.set(conversationId, record);
    this.sessionsById.set(record.sessionId, record);
  }

  deleteSession(conversationId: string): void {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      this.sessionsById.delete(existing.sessionId);
    }
    this.sessions.delete(conversationId);
  }

  getAllSessions(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  getSessionsByAgent(agentId: string): SessionRecord[] {
    return this.getAllSessions().filter((session) => session.agentId === agentId);
  }

  getAgentDef(conversationId: string): AgentDefinition | undefined {
    return this.agentDefs.get(conversationId);
  }

  setAgentDef(conversationId: string, def: AgentDefinition): void {
    this.agentDefs.set(conversationId, def);
  }

  deleteAgentDef(conversationId: string): void {
    this.agentDefs.delete(conversationId);
  }

  getQueue(sessionId: string): TurnQueueEntry[] | undefined {
    return this.turnQueues.get(sessionId);
  }

  getOrCreateQueue(sessionId: string): TurnQueueEntry[] {
    let queue = this.turnQueues.get(sessionId);
    if (!queue) {
      queue = [];
      this.turnQueues.set(sessionId, queue);
    }
    return queue;
  }

  deleteQueue(sessionId: string): void {
    this.turnQueues.delete(sessionId);
  }

  isActiveTurn(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  markTurnActive(sessionId: string): void {
    this.activeTurns.add(sessionId);
  }

  markTurnInactive(sessionId: string): void {
    this.activeTurns.delete(sessionId);
  }

  cleanupSession(sessionId: string, conversationId: string): void {
    this.sessions.delete(conversationId);
    this.sessionsById.delete(sessionId);
    this.turnQueues.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.agentDefs.delete(conversationId);
  }

  async withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.conversationLocks.get(conversationId) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    this.conversationLocks.set(conversationId, next);

    try {
      await prev;
      return await fn();
    } finally {
      resolve();
      if (this.conversationLocks.get(conversationId) === next) {
        this.conversationLocks.delete(conversationId);
      }
    }
  }
}
