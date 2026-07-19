import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { SessionEvent } from '../../packages/ctxmill/src/orchestrator/session-turn-service.js';

export const MAX_CONCURRENT_TURNS_PER_AGENT = 3;

export type TestTurnStatus = 'queued' | 'running' | 'suspended' | 'completed' | 'error' | 'cancelled';

export type TestTurnRecord = {
  turnId: string;
  sandboxSessionId: string;
  agentId: string;
  conversationId: string;
  status: TestTurnStatus;
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  taskDescription: string | null;
  suspendedAt?: number;
  suspendReason?: string;
  resumedAt?: number;
};

type StartTurnOptions = {
  maxConcurrent?: number;
  sandboxSessionId?: string;
};

const ACTIVE_STATUSES: readonly TestTurnStatus[] = ['queued', 'running', 'suspended'];

export class TestTurnRegistry {
  private readonly turns = new Map<string, TestTurnRecord>();

  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly eventBus?: TypedEventBus) {}

  async startTurn(
    agentId: string,
    conversationId: string,
    mode: 'interactive' | 'background',
    taskDescription?: string,
    options?: StartTurnOptions,
  ): Promise<TestTurnRecord> {
    const limit = options?.maxConcurrent ?? MAX_CONCURRENT_TURNS_PER_AGENT;
    if (this.getActiveTurns(agentId).length >= limit) {
      throw new Error(`Concurrent turn limit exceeded for agent ${agentId}`);
    }

    const now = Date.now();
    const turn: TestTurnRecord = {
      turnId: randomUUID(),
      sandboxSessionId: options?.sandboxSessionId ?? randomUUID(),
      agentId,
      conversationId,
      status: 'running',
      mode,
      startedAt: now,
      completedAt: null,
      error: null,
      taskDescription: taskDescription ?? null,
    };
    this.turns.set(turn.turnId, turn);
    this.controllers.set(turn.turnId, new AbortController());
    this.eventBus?.emit('turn.started', {
      turnId: turn.turnId,
      sandboxSessionId: turn.sandboxSessionId,
      agentId,
      conversationId,
      mode,
      taskDescription: taskDescription ?? '',
      timestamp: now,
    });
    return { ...turn };
  }

  getTurn(turnId: string): TestTurnRecord | undefined {
    const turn = this.turns.get(turnId);
    return turn ? { ...turn } : undefined;
  }

  getAbortSignal(turnId: string): AbortSignal | undefined {
    return this.controllers.get(turnId)?.signal;
  }

  getAllTurns(): TestTurnRecord[] {
    return Array.from(this.turns.values()).map((turn) => ({ ...turn }));
  }

  getActiveTurns(agentId: string): TestTurnRecord[] {
    return this.getAllTurns().filter(
      (turn) => turn.agentId === agentId && ACTIVE_STATUSES.includes(turn.status),
    );
  }

  getTurnBySandboxSessionId(sandboxSessionId: string): TestTurnRecord | undefined {
    const turn = this.getAllTurns().find(
      (candidate) => candidate.sandboxSessionId === sandboxSessionId,
    );
    return turn ? { ...turn } : undefined;
  }

  private updateTurn(turnId: string, patch: Partial<TestTurnRecord>): TestTurnRecord | undefined {
    const existing = this.turns.get(turnId);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.turns.set(turnId, updated);
    return { ...updated };
  }

  async suspendTurn(turnId: string, reason: string): Promise<TestTurnRecord | undefined> {
    const existing = this.turns.get(turnId);
    if (!existing || existing.status !== 'running') return undefined;
    return this.updateTurn(turnId, { status: 'suspended', suspendedAt: Date.now(), suspendReason: reason });
  }

  async completeTurn(turnId: string, error?: string): Promise<TestTurnRecord | undefined> {
    const existing = this.turns.get(turnId);
    if (!existing) return undefined;
    this.controllers.delete(turnId);
    const completedAt = Date.now();
    const status = error ? 'error' : 'completed';
    const updated = this.updateTurn(turnId, {
      status,
      completedAt,
      error: error ?? null,
    });
    if (!updated) return undefined;
    this.eventBus?.emit('turn.completed', {
      turnId,
      sandboxSessionId: updated.sandboxSessionId,
      agentId: updated.agentId,
      conversationId: updated.conversationId,
      status,
      error,
      durationMs: completedAt - updated.startedAt,
      timestamp: completedAt,
    });
    return updated;
  }

  async cancelTurn(turnId: string): Promise<TestTurnRecord | undefined> {
    const existing = this.turns.get(turnId);
    if (!existing) return undefined;
    this.controllers.get(turnId)?.abort();
    this.controllers.delete(turnId);
    const completedAt = Date.now();
    const updated = this.updateTurn(turnId, {
      status: 'cancelled',
      completedAt,
    });
    if (!updated) return undefined;
    this.eventBus?.emit('turn.completed', {
      turnId,
      sandboxSessionId: updated.sandboxSessionId,
      agentId: updated.agentId,
      conversationId: updated.conversationId,
      status: 'cancelled',
      durationMs: completedAt - updated.startedAt,
      timestamp: completedAt,
    });
    return updated;
  }
}

export function createTestSandboxSessionManager(
  registry: TestTurnRegistry,
  options?: {
    sandboxSessionId?: string;
    deliverTurn?: (sandboxSessionId: string, messages: Message[], turnId: string) => AsyncGenerator<SessionEvent>;
  },
) {
  const defaultSandboxSessionId = options?.sandboxSessionId ?? 'sandbox-session-1';
  const turnIdsBySessionId = new Map<string, string>();

  return {
    ensureSession: async (conversationId: string, _agentDef: AgentDefinition, _agentId: string) => {
      const sandboxSessionId = registry.getAllTurns().find(
        (turn) => turn.conversationId === conversationId && ACTIVE_STATUSES.includes(turn.status),
      )?.sandboxSessionId ?? defaultSandboxSessionId;
      return { sessionId: sandboxSessionId };
    },
    deliverTurn: options?.deliverTurn ?? (async function* () {}) as (
      sandboxSessionId: string,
      messages: Message[],
      turnId: string,
    ) => AsyncGenerator<SessionEvent>,
    killSession: async () => {},
    findSessionById: vi.fn(),
    startTurn: (sandboxSessionId: string, turnId: string) => {
      turnIdsBySessionId.set(sandboxSessionId, turnId);
      return registry.getAbortSignal(turnId);
    },
    completeTurn: async (_sandboxSessionId: string, turnId: string, _agentId: string, _conversationId: string, status: 'completed' | 'error' | 'cancelled', _durationMs: number, error?: string) => {
      if (status === 'cancelled') {
        await registry.cancelTurn(turnId);
        return;
      }
      await registry.completeTurn(turnId, error);
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
