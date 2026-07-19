import type { DatabaseRepository } from '../database/repository.js';
import type { TurnSelect } from '../database/types.js';
import type { EventMap, TypedEventBus } from '../events/bus.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

interface PendingTerminalPublisherDeps {
  db: Pick<DatabaseRepository, 'getTurnsPendingCanonicalTerminalPublish'>;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  logger: Logger;
}

export function turnCompletedPayload(turn: TurnSelect): EventMap['turn.completed'] {
  if (
    turn.completedAt == null
    || turn.status === 'queued'
    || turn.status === 'running'
  ) {
    throw new Error(`Turn ${turn.id} is not terminal`);
  }

  const hasUsage = turn.inputTokens != null
    && turn.outputTokens != null
    && turn.totalTokens != null;
  return {
    turnId: turn.id,
    ...(turn.sandboxSessionId ? { sandboxSessionId: turn.sandboxSessionId } : {}),
    agentId: turn.agentId,
    conversationId: turn.conversationId ?? '',
    status: turn.status,
    ...(turn.error ? { error: turn.error } : {}),
    durationMs: Math.max(0, turn.completedAt - turn.startedAt),
    ...(hasUsage
      ? {
        usage: {
          inputTokens: turn.inputTokens!,
          outputTokens: turn.outputTokens!,
          totalTokens: turn.totalTokens!,
          ...(turn.costUsd != null ? { costUsd: turn.costUsd } : {}),
        },
      }
      : {}),
    timestamp: turn.completedAt,
  };
}

/** Rebuild terminal frame batches left pending between row finalization and event persistence. */
export async function reconcilePendingTerminalPublishesOnStartup(
  deps: PendingTerminalPublisherDeps,
): Promise<number> {
  const pending = await deps.db.getTurnsPendingCanonicalTerminalPublish();
  let published = 0;
  for (const turn of pending) {
    await deps.eventBus.emitAsync('turn.completed', turnCompletedPayload(turn));
    published++;
  }
  if (published > 0) {
    deps.logger.info(
      '[TurnTerminalPublisher] rebuilt %d canonical terminal event(s) from durable rows',
      published,
    );
  }
  return published;
}
