import type { DatabaseRepository } from '../database/repository.js';
import type { TurnSelect } from '../database/types.js';
import { mapMessagesToInternal } from './routes/agent-helpers.js';
import type { RedispatchQueuedRunParams } from './run-startup-service.js';
import {
  TOOL_CALL_INTERRUPTED_ERROR,
  TURN_ERROR_ORCHESTRATOR_RESTART,
  type TurnFinalizer,
} from './turn-finalizer.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

interface TurnReconcilerDeps {
  db: Pick<
    DatabaseRepository,
    'getOpenTurnsStartedBefore' | 'getPendingInterrupt' | 'getMessages' | 'getTurnFrames' | 'updateMessageToolCallsAndParts'
  >;
  finalizer: TurnFinalizer;
  logger: Logger;
  redispatchQueuedTurn?: (params: RedispatchQueuedRunParams) => Promise<void>;
  resetStrandedSession?: (sessionId: string) => Promise<void>;
}

interface TurnReconciliationResult {
  failed: number;
  skippedHitlParked: number;
  redispatched: number;
  redispatchComplete: Promise<void>;
}

export interface ConversationToolCallRepairDeps {
  db: Pick<DatabaseRepository, 'getMessages' | 'updateMessageToolCallsAndParts'>;
  logger: Logger;
}

const TAG = '[TurnReconciler]';

type ToolCallish = { status?: unknown; error?: unknown; type?: unknown };

interface QueuedRedispatchCandidate {
  turn: TurnSelect;
  params: RedispatchQueuedRunParams;
  order: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mark still-running tool-call entries as errored; returns the repaired array or null when untouched. */
export function repairRunningEntries(entries: unknown[] | null | undefined, partsMode: boolean): unknown[] | null {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  let repaired = false;
  const next = entries.map((entry) => {
    if (!isRecord(entry)) return entry;
    const candidate = entry as ToolCallish;
    if (partsMode && candidate.type !== 'tool_call') return entry;
    if (candidate.status !== 'running' && candidate.status !== 'pending') return entry;
    repaired = true;
    return { ...entry, status: 'error', error: TOOL_CALL_INTERRUPTED_ERROR };
  });
  return repaired ? next : null;
}

/**
 * Startup turn reconciliation (ADR-014, ctx-nm3o). Turn generators are
 * in-process, so any turn open at boot that started before boot is stranded
 * by construction — unless it is parked on a durable HITL interrupt
 * (pending/timed_out row), which the durable resume path (WS-B) owns.
 * Stranded turns are failed with restart error copy, and their persisted
 * messages are repaired so no terminal turn retains 'running' tool calls in
 * either the toolCalls or parts projection.
 */
export async function reconcileStrandedTurnsOnStartup(
  deps: TurnReconcilerDeps,
  bootTimeMs: number,
): Promise<TurnReconciliationResult> {
  const openTurns = await deps.db.getOpenTurnsStartedBefore(bootTimeMs);
  let failed = 0;
  let skippedHitlParked = 0;
  let redispatched = 0;
  const strandedTurns: TurnSelect[] = [];
  const queuedCandidates: QueuedRedispatchCandidate[] = [];
  const strandedSessionIds = new Set<string>();

  for (const turn of openTurns) {
    try {
      const interrupt = await deps.db.getPendingInterrupt(turn.id);
      if (interrupt && (interrupt.status === 'pending' || interrupt.status === 'timed_out')) {
        skippedHitlParked++;
        deps.logger.info(`${TAG} turn ${turn.id} is parked on a durable HITL interrupt; leaving open for resume`);
        continue;
      }

      if (turn.status === 'queued' && deps.redispatchQueuedTurn) {
        const queuedCandidate = await buildQueuedRedispatchCandidate(deps, turn);
        if (queuedCandidate) {
          queuedCandidates.push(queuedCandidate);
          continue;
        }
      }

      strandedTurns.push(turn);
    } catch (err) {
      deps.logger.error(`${TAG} failed to reconcile stranded turn ${turn.id}:`, err);
    }
  }

  for (const turn of strandedTurns) {
    try {
      const finalized = await failStrandedTurn(deps, turn);
      if (finalized) {
        failed++;
        if (turn.status !== 'queued' && turn.sessionId) {
          strandedSessionIds.add(turn.sessionId);
        }
      }
    } catch (err) {
      deps.logger.error(`${TAG} failed to finalize stranded turn ${turn.id}:`, err);
    }
  }

  await resetStrandedSessions(deps, strandedSessionIds);

  const redispatchComplete = processQueuedRedispatches(deps, queuedCandidates, {
    onRedispatched: () => {
      redispatched++;
    },
    onFailed: () => {
      failed++;
    },
  });
  await redispatchComplete;

  if (failed > 0 || skippedHitlParked > 0 || redispatched > 0) {
    deps.logger.info(
      `${TAG} startup reconciliation closed ${failed} stranded turn(s), redispatched ${redispatched} queued turn(s), left ${skippedHitlParked} HITL-parked turn(s) open`,
    );
  }

  return { failed, skippedHitlParked, redispatched, redispatchComplete };
}

export async function repairConversationRunningToolCalls(
  deps: ConversationToolCallRepairDeps,
  conversationId: string,
): Promise<void> {
  const messages = await deps.db.getMessages(conversationId);
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    const repairedToolCalls = repairRunningEntries(message.toolCalls, false);
    const repairedParts = repairRunningEntries(message.parts, true);
    if (repairedToolCalls || repairedParts) {
      await deps.db.updateMessageToolCallsAndParts(message.id, repairedToolCalls, repairedParts);
    }
  }
}

async function buildQueuedRedispatchCandidate(
  deps: TurnReconcilerDeps,
  turn: TurnSelect,
): Promise<QueuedRedispatchCandidate | null> {
  if (!turn.conversationId || !turn.userMessageId) {
    deps.logger.warn(`${TAG} queued turn ${turn.id} is missing conversation/user-message linkage; failing as stranded`);
    return null;
  }

  const messages = await deps.db.getMessages(turn.conversationId);
  const userMessageIndex = messages.findIndex((message) => message.id === turn.userMessageId);
  if (userMessageIndex < 0) {
    deps.logger.warn(`${TAG} queued turn ${turn.id} user message ${turn.userMessageId} not found; failing as stranded`);
    return null;
  }

  const frames = await deps.db.getTurnFrames(turn.id);
  const emitTurnStarted = !frames.some((frame) => frame.type === 'RUN_STARTED');
  const messagesForTurn = messages.slice(0, userMessageIndex + 1);

  return {
    turn,
    order: userMessageIndex,
    params: {
      turnId: turn.id,
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      mode: turn.mode === 'background' ? 'background' : 'interactive',
      taskDescription: turn.taskDescription ?? messages[userMessageIndex]?.content ?? '',
      userMessageId: turn.userMessageId,
      messages: mapMessagesToInternal(messagesForTurn, turn.agentId),
      emitTurnStarted,
    },
  };
}

async function failStrandedTurn(
  deps: TurnReconcilerDeps,
  turn: TurnSelect,
  error = TURN_ERROR_ORCHESTRATOR_RESTART,
): Promise<boolean> {
  if (turn.conversationId) {
    await repairConversationRunningToolCalls(deps, turn.conversationId);
  }

  const result = await deps.finalizer.finalize({
    turnId: turn.id,
    agentId: turn.agentId,
    conversationId: turn.conversationId ?? '',
    ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
    status: 'error',
    error,
    durationMs: Date.now() - turn.startedAt,
  });
  return result.finalized;
}

async function resetStrandedSessions(
  deps: TurnReconcilerDeps,
  sessionIds: ReadonlySet<string>,
): Promise<void> {
  if (!deps.resetStrandedSession || sessionIds.size === 0) {
    return;
  }

  await Promise.all(Array.from(sessionIds).map(async (sessionId) => {
    try {
      await deps.resetStrandedSession!(sessionId);
    } catch (err) {
      deps.logger.error(`${TAG} failed to reset stranded session ${sessionId}:`, err);
    }
  }));
}

async function processQueuedRedispatches(
  deps: TurnReconcilerDeps,
  queuedCandidates: QueuedRedispatchCandidate[],
  callbacks: { onRedispatched: () => void; onFailed: () => void },
): Promise<void> {
  if (!deps.redispatchQueuedTurn || queuedCandidates.length === 0) {
    return;
  }

  const byAgent = new Map<string, QueuedRedispatchCandidate[]>();
  for (const candidate of queuedCandidates) {
    const group = byAgent.get(candidate.turn.agentId) ?? [];
    group.push(candidate);
    byAgent.set(candidate.turn.agentId, group);
  }

  await Promise.all(Array.from(byAgent.values()).map(async (agentCandidates) => {
    agentCandidates.sort((a, b) => {
      const conversationCompare = (a.turn.conversationId ?? '').localeCompare(b.turn.conversationId ?? '');
      if (conversationCompare !== 0) {
        return conversationCompare;
      }
      return a.order - b.order || a.turn.startedAt - b.turn.startedAt || a.turn.id.localeCompare(b.turn.id);
    });

    for (const candidate of agentCandidates) {
      try {
        await deps.redispatchQueuedTurn!(candidate.params);
        callbacks.onRedispatched();
      } catch (err) {
        deps.logger.error(`${TAG} queued turn ${candidate.turn.id} redispatch failed:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        const finalized = await failStrandedTurn(deps, candidate.turn, errorMessage);
        if (finalized) {
          callbacks.onFailed();
        }
      }
    }
  }));
}
