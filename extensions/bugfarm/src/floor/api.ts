import { StablehandApiError, StablehandControlClient } from '@stablehand/client';
import type { Turn } from '@stablehand/contracts';

/**
 * The foreman's view of Stablehand: find the floor agents, start their turns, wait for them.
 * An interface so the foreman can be tested without a stack.
 */

export interface TurnInfo {
  id: string;
  agentId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'ERROR' | 'CANCELLED';
  error: string | null;
  /** `budget_reached` when the run hit its spend cap. */
  stopCode: string | null;
  /** Dollars the gateway has counted for the turn; null while unpriced. */
  costUsd: number | null;
  costCoverage: string | null;
  tags: Record<string, string>;
}

export interface StartTurnInput {
  agentId: string;
  task: string;
  tags: Record<string, string>;
  /** Same key, same turn: a restarted foreman gets the turn it already started back. */
  idempotencyKey: string;
}

export interface FloorApi {
  findAgentByName(name: string): Promise<string | null>;
  startTurn(input: StartTurnInput): Promise<{ turnId: string }>;
  waitForTurn(turnId: string, timeoutMs: number): Promise<TurnInfo>;
  lookupTurn(turnId: string): Promise<TurnInfo>;
}

/** A refusal to start a turn because a budget is spent. The campaign stops; nothing retries it. */
export class BudgetBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetBlockedError';
  }
}

export function toTurnInfo(turn: Turn): TurnInfo {
  const cost = turn.usage?.cost ?? null;
  return {
    id: turn.id,
    agentId: turn.agentId,
    status: turn.status,
    error: turn.error,
    stopCode: turn.stopReason?.code ?? null,
    costUsd: cost ? (cost.totalUsd ?? cost.knownUsd) : null,
    costCoverage: cost?.coverage ?? null,
    tags: turn.tags ?? {},
  };
}

export class StablehandFloorApi implements FloorApi {
  private readonly client: StablehandControlClient;

  constructor(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    this.client = new StablehandControlClient({
      apiBase: `${options.baseUrl.replace(/\/+$/, '')}/api`,
      token: options.token,
      timeoutMs: 60_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async findAgentByName(name: string): Promise<string | null> {
    const agents = await this.client.agents.list();
    return agents.find((agent) => agent.name === name)?.id ?? null;
  }

  async startTurn(input: StartTurnInput): Promise<{ turnId: string }> {
    try {
      const started = await this.client.turns.startBackground(
        input.agentId,
        { task: input.task, tags: input.tags },
        { idempotencyKey: input.idempotencyKey },
      );
      return { turnId: started.turnId };
    } catch (err) {
      if (err instanceof StablehandApiError && err.code === 'budget_exceeded') {
        const body = err.body as { error?: string } | null;
        throw new BudgetBlockedError(body?.error ?? 'a budget policy refused the turn');
      }
      throw err;
    }
  }

  async waitForTurn(turnId: string, timeoutMs: number): Promise<TurnInfo> {
    return toTurnInfo(await this.client.waitForTurn(turnId, { timeoutMs, maxPollIntervalMs: 5_000 }));
  }

  async lookupTurn(turnId: string): Promise<TurnInfo> {
    return toTurnInfo((await this.client.turns.lookup(turnId)).turn);
  }
}
