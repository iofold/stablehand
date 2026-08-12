import type { DatabaseRepository } from '../database/repository.js';

/**
 * Durable turn-queue admission (ctx-z5k0). Rejection happens BEFORE any
 * write — no message, no turn row — so a 429 caller owns the retry with
 * nothing half-accepted (signed-off design, 2026-08-12).
 */
export class QueueFullError extends Error {
  readonly code = 'queue_full';
  readonly statusCode = 429;
  readonly retryAfterSec = 5;

  constructor(
    readonly scope: 'global' | 'agent',
    readonly agentId: string,
    readonly queued: number,
    readonly limit: number,
  ) {
    super(
      scope === 'global'
        ? `Turn queue is full (${queued}/${limit} queued turns). Retry later.`
        : `Turn queue for agent ${agentId} is full (${queued}/${limit} queued turns). Retry later.`,
    );
    this.name = 'QueueFullError';
  }
}

export interface TurnQueueAdmission {
  check(agentId: string): Promise<void>;
}

export interface TurnQueueAdmissionDeps {
  db: Pick<DatabaseRepository, 'countQueuedTurns'>;
  settings: () => Promise<{ maxQueuedTurnsGlobal: number; maxQueuedTurnsPerAgent: number }>;
}

export function createTurnQueueAdmission(deps: TurnQueueAdmissionDeps): TurnQueueAdmission {
  return {
    async check(agentId: string): Promise<void> {
      const [settings, counts] = await Promise.all([
        deps.settings(),
        deps.db.countQueuedTurns(agentId),
      ]);
      if (counts.global >= settings.maxQueuedTurnsGlobal) {
        throw new QueueFullError('global', agentId, counts.global, settings.maxQueuedTurnsGlobal);
      }
      if (counts.agent >= settings.maxQueuedTurnsPerAgent) {
        throw new QueueFullError('agent', agentId, counts.agent, settings.maxQueuedTurnsPerAgent);
      }
    },
  };
}
