import type { AgentDefinition } from '../../types.js';
import type { SessionStatePort } from './ports.js';
import type { SessionRecord, TurnQueueEntry } from './types.js';

export class SessionStateStore implements SessionStatePort {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionsById = new Map<string, SessionRecord>();

  private readonly turnQueues = new Map<string, TurnQueueEntry[]>();

  private readonly activeTurns = new Map<string, string>();

  private readonly turnControllers = new Map<string, Map<string, AbortController>>();

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

  getActiveTurnId(sessionId: string): string | undefined {
    return this.activeTurns.get(sessionId);
  }

  markTurnActive(sessionId: string, turnId: string): void {
    this.activeTurns.set(sessionId, turnId);
  }

  markTurnInactive(sessionId: string, turnId?: string): void {
    if (turnId !== undefined && this.activeTurns.get(sessionId) !== turnId) {
      return;
    }
    this.activeTurns.delete(sessionId);
  }

  rebindTurnRuntime(previousSessionId: string, nextSessionId: string, turnId: string): void {
    if (previousSessionId === nextSessionId) {
      return;
    }

    if (this.activeTurns.get(previousSessionId) === turnId) {
      this.activeTurns.delete(previousSessionId);
      this.activeTurns.set(nextSessionId, turnId);
    }

    const previousControllers = this.turnControllers.get(previousSessionId);
    if (previousControllers && previousControllers.size > 0) {
      let nextControllers = this.turnControllers.get(nextSessionId);
      if (!nextControllers) {
        nextControllers = new Map<string, AbortController>();
        this.turnControllers.set(nextSessionId, nextControllers);
      }
      for (const [queuedTurnId, controller] of previousControllers) {
        nextControllers.set(queuedTurnId, controller);
      }
      this.turnControllers.delete(previousSessionId);
    }

    const previousQueue = this.turnQueues.get(previousSessionId);
    if (previousQueue) {
      if (previousQueue.length > 0) {
        this.getOrCreateQueue(nextSessionId).push(...previousQueue.splice(0));
      }
      this.turnQueues.delete(previousSessionId);
    }
  }

  registerTurnController(sessionId: string, turnId: string, controller: AbortController): void {
    let controllers = this.turnControllers.get(sessionId);
    if (!controllers) {
      controllers = new Map<string, AbortController>();
      this.turnControllers.set(sessionId, controllers);
    }
    controllers.set(turnId, controller);
  }

  getTurnAbortSignal(sessionId: string, turnId: string): AbortSignal | undefined {
    return this.turnControllers.get(sessionId)?.get(turnId)?.signal;
  }

  abortTurn(sessionId: string, turnId: string): boolean {
    const controller = this.turnControllers.get(sessionId)?.get(turnId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  clearTurnController(sessionId: string, turnId: string): void {
    const controllers = this.turnControllers.get(sessionId);
    if (!controllers) {
      return;
    }
    controllers.delete(turnId);
    if (controllers.size === 0) {
      this.turnControllers.delete(sessionId);
    }
  }

  cleanupSession(sessionId: string, conversationId: string): void {
    this.sessions.delete(conversationId);
    this.sessionsById.delete(sessionId);
    this.turnQueues.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.turnControllers.delete(sessionId);
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
