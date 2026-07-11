import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { SessionEvent } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';

export const MAX_CONCURRENT_SESSIONS_PER_AGENT = 3;

export type TestSessionStatus = 'queued' | 'running' | 'suspended' | 'completed' | 'error' | 'cancelled';

export type TestSessionRecord = {
  id: string;
  agentId: string;
  conversationId: string;
  status: TestSessionStatus;
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  taskDescription: string | null;
  suspendedAt?: number;
  suspendReason?: string;
  resumedAt?: number;
};

type SessionDb = {
  createSession?: (data: TestSessionRecord) => Promise<unknown>;
  updateSession?: (id: string, data: Partial<TestSessionRecord>) => Promise<unknown>;
  getAllSessions?: () => Promise<TestSessionRecord[]>;
};

type StartOptions = {
  maxConcurrent?: number;
};

const ACTIVE_STATUSES: readonly TestSessionStatus[] = ['queued', 'running', 'suspended'];

export class TestSessionRegistry {
  private readonly sessions = new Map<string, TestSessionRecord>();

  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly db?: SessionDb,
    private readonly eventBus?: TypedEventBus,
  ) {}

  async startSession(
    agentId: string,
    conversationId: string,
    mode: 'interactive' | 'background',
    taskDescription?: string,
    options?: StartOptions,
  ): Promise<TestSessionRecord> {
    const limit = options?.maxConcurrent ?? MAX_CONCURRENT_SESSIONS_PER_AGENT;
    if (this.getActiveSessions(agentId).length >= limit) {
      throw new Error(`Concurrent run limit exceeded for agent ${agentId}`);
    }

    const now = Date.now();
    const session: TestSessionRecord = {
      id: randomUUID(),
      agentId,
      conversationId,
      status: 'running',
      mode,
      startedAt: now,
      completedAt: null,
      error: null,
      taskDescription: taskDescription ?? null,
    };
    this.sessions.set(session.id, session);
    this.controllers.set(session.id, new AbortController());
    await this.db?.createSession?.(session);
    this.eventBus?.emit('turn.started', {
      turnId: session.id,
      sessionId: session.id,
      agentId,
      conversationId,
      mode,
      taskDescription: taskDescription ?? '',
      timestamp: now,
    });
    return { ...session };
  }

  startRun(
    agentId: string,
    conversationId: string,
    mode: 'interactive' | 'background',
    taskDescription?: string,
    options?: StartOptions,
  ): Promise<TestSessionRecord> {
    return this.startSession(agentId, conversationId, mode, taskDescription, options);
  }

  getSession(id: string): TestSessionRecord | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session } : undefined;
  }

  getRun(id: string): TestSessionRecord | undefined {
    return this.getSession(id);
  }

  getAbortSignal(id: string): AbortSignal | undefined {
    return this.controllers.get(id)?.signal;
  }

  getAllSessions(): TestSessionRecord[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session }));
  }

  getActiveSessions(agentId: string): TestSessionRecord[] {
    return this.getAllSessions().filter(
      (session) => session.agentId === agentId && ACTIVE_STATUSES.includes(session.status),
    );
  }

  getActiveRuns(agentId: string): TestSessionRecord[] {
    return this.getActiveSessions(agentId);
  }

  getActiveSessionsForAgent(agentId: string): TestSessionRecord[] {
    return this.getActiveSessions(agentId);
  }

  getSessionsByStatus(status: TestSessionStatus, agentId?: string): TestSessionRecord[] {
    return this.getAllSessions().filter(
      (session) => session.status === status && (agentId === undefined || session.agentId === agentId),
    );
  }

  private async updateSession(id: string, patch: Partial<TestSessionRecord>): Promise<TestSessionRecord | undefined> {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.sessions.set(id, updated);
    await this.db?.updateSession?.(id, patch);
    return { ...updated };
  }

  async suspendSession(id: string, reason: string): Promise<TestSessionRecord | undefined> {
    const existing = this.sessions.get(id);
    if (!existing || existing.status !== 'running') return undefined;
    return this.updateSession(id, { status: 'suspended', suspendedAt: Date.now(), suspendReason: reason });
  }

  async completeSession(id: string, error?: string): Promise<TestSessionRecord | undefined> {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    this.controllers.delete(id);
    const completedAt = Date.now();
    const status = error ? 'error' : 'completed';
    const updated = await this.updateSession(id, {
      status,
      completedAt,
      error: error ?? null,
    });
    if (!updated) return undefined;
    this.eventBus?.emit('turn.completed', {
      turnId: id,
      sessionId: id,
      agentId: updated.agentId,
      conversationId: updated.conversationId,
      status,
      error,
      durationMs: completedAt - updated.startedAt,
      timestamp: completedAt,
    });
    return updated;
  }

  completeRun(id: string, error?: string): Promise<TestSessionRecord | undefined> {
    return this.completeSession(id, error);
  }

  async cancelSession(id: string): Promise<TestSessionRecord | undefined> {
    const existing = this.sessions.get(id);
    if (!existing) return undefined;
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    const completedAt = Date.now();
    const updated = await this.updateSession(id, {
      status: 'cancelled',
      completedAt,
    });
    if (!updated) return undefined;
    this.eventBus?.emit('turn.completed', {
      turnId: id,
      sessionId: id,
      agentId: updated.agentId,
      conversationId: updated.conversationId,
      status: 'cancelled',
      durationMs: completedAt - updated.startedAt,
      timestamp: completedAt,
    });
    return updated;
  }

  cancelRun(id: string): Promise<TestSessionRecord | undefined> {
    return this.cancelSession(id);
  }

  async loadFromDb(db: SessionDb): Promise<void> {
    const rows = (await db.getAllSessions?.()) ?? [];
    for (const row of rows) {
      const session = { ...row };
      if (session.status === 'running') {
        session.status = 'error';
        session.error = 'Server restarted during execution';
        session.completedAt = Date.now();
        await db.updateSession?.(session.id, {
          status: session.status,
          error: session.error,
          completedAt: session.completedAt,
        });
      }
      this.sessions.set(session.id, session);
      if (ACTIVE_STATUSES.includes(session.status)) {
        this.controllers.set(session.id, new AbortController());
      }
    }
  }
}

export function createTestSessionManager(
  registry: TestSessionRegistry,
  options?: {
    sessionId?: string;
    deliverTurn?: (sessionId: string, messages: Message[], turnId: string) => AsyncGenerator<SessionEvent>;
  },
) {
  const sessionId = options?.sessionId ?? 'sandbox-session-1';
  const turnIdsBySessionId = new Map<string, string>();

  return {
    ensureSession: async (_conversationId: string, _agentDef: AgentDefinition, _agentId: string) => ({ sessionId }),
    deliverTurn: options?.deliverTurn ?? (async function* () {}) as (sessionId: string, messages: Message[], turnId: string) => AsyncGenerator<SessionEvent>,
    killSession: async () => {},
    findSessionById: vi.fn(),
    startTurn: (sandboxSessionId: string, turnId: string) => {
      turnIdsBySessionId.set(sandboxSessionId, turnId);
      return registry.getAbortSignal(turnId);
    },
    completeTurn: async (_sandboxSessionId: string, turnId: string, _agentId: string, _conversationId: string, status: 'completed' | 'error' | 'cancelled', _durationMs: number, error?: string) => {
      if (status === 'cancelled') {
        await registry.cancelSession(turnId);
        return;
      }
      await registry.completeSession(turnId, error);
    },
    cancelCurrentTurn: () => false,
    getAbortSignal: (sandboxSessionId: string) => {
      const turnId = turnIdsBySessionId.get(sandboxSessionId);
      return turnId ? registry.getAbortSignal(turnId) : undefined;
    },
    getSession: vi.fn(),
    getActiveSessions: () => [],
  };
}
