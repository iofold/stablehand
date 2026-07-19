import { randomUUID } from 'node:crypto';
import type { DatabaseRepository } from '../database/repository.js';
import type { EventFrameRow, TurnSelect } from '../database/types.js';
import type { EventMap, TypedEventBus } from '../events/bus.js';
import { unrefTimer } from '../util/timing.js';
import {
  publishMessageCanonicalState,
} from './message-publisher.js';
import { mapMessagesToInternal } from './routes/agent-helpers.js';
import type { RedispatchQueuedTurnParams } from './turn-startup-service.js';
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
    | 'getOpenTurnsStartedBefore'
    | 'getPendingInterruptForTurn'
    | 'getMessages'
    | 'getTurnFrames'
    | 'stageAssistantMessageUpdate'
    | 'claimTurnReconciliationLease'
    | 'renewTurnReconciliationLease'
    | 'authorizeQueuedTurnRedispatch'
    | 'releaseTurnReconciliationLease'
  >;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  finalizer: TurnFinalizer;
  logger: Logger;
  redispatchQueuedTurn?: (
    params: RedispatchQueuedTurnParams,
    signal: AbortSignal,
  ) => Promise<void>;
  resetStrandedSession?: (sessionId: string) => Promise<void>;
}

interface TurnReconciliationResult {
  failed: number;
  skippedHitlParked: number;
  redispatched: number;
  redispatchComplete: Promise<void>;
}

interface TurnReconciliationOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  ownerId?: string;
  now?: () => number;
}

interface TurnLeaseContext {
  leaseMs: number;
  heartbeatMs: number;
  ownerId: string;
  now: () => number;
}

export interface ConversationToolCallRepairDeps {
  db: Pick<DatabaseRepository, 'getMessages' | 'stageAssistantMessageUpdate'>;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  logger: Logger;
}

const TAG = '[TurnReconciler]';
const DEFAULT_RECONCILIATION_LEASE_MS = 60_000;
const DEFAULT_RECONCILIATION_HEARTBEAT_MS = 20_000;

type ToolCallish = { status?: unknown; error?: unknown; type?: unknown };

interface QueuedRedispatchCandidate {
  turn: TurnSelect;
  params: RedispatchQueuedTurnParams;
  republishUserMessage: EventMap['user.message'] | null;
  order: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasDurableUserMessage(frames: EventFrameRow[], messageId: string): boolean {
  return frames.some((frame) => {
    if (frame.sourceType === 'user.message') {
      return true;
    }
    if (frame.type !== 'TEXT_MESSAGE_START') {
      return false;
    }
    try {
      const payload = JSON.parse(frame.payload) as unknown;
      return isRecord(payload) && payload.role === 'user' && payload.messageId === messageId;
    } catch {
      return false;
    }
  });
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
  options: TurnReconciliationOptions = {},
): Promise<TurnReconciliationResult> {
  const leaseContext: TurnLeaseContext = {
    leaseMs: options.leaseMs ?? DEFAULT_RECONCILIATION_LEASE_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_RECONCILIATION_HEARTBEAT_MS,
    ownerId: options.ownerId ?? randomUUID(),
    now: options.now ?? Date.now,
  };
  if (leaseContext.leaseMs <= 0 || leaseContext.heartbeatMs <= 0) {
    throw new Error('Turn reconciliation lease and heartbeat durations must be positive');
  }
  if (leaseContext.heartbeatMs >= leaseContext.leaseMs) {
    throw new Error('Turn reconciliation heartbeat must be shorter than its lease');
  }

  const openTurns = await deps.db.getOpenTurnsStartedBefore(bootTimeMs);
  let failed = 0;
  let skippedHitlParked = 0;
  let redispatched = 0;
  const strandedTurns: TurnSelect[] = [];
  const queuedCandidates: QueuedRedispatchCandidate[] = [];
  const strandedSessionIds = new Set<string>();

  for (const turn of openTurns) {
    try {
      const interrupt = await deps.db.getPendingInterruptForTurn(turn.id);
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
      const outcome = await withTurnReconciliationLease(
        deps,
        turn.id,
        leaseContext,
        async () => {
          const finalized = await failStrandedTurn(deps, turn);
          if (finalized && turn.status !== 'queued' && turn.sandboxSessionId) {
            strandedSessionIds.add(turn.sandboxSessionId);
          }
          return finalized;
        },
      );
      if (outcome.claimed && outcome.value) {
        failed++;
      } else if (!outcome.claimed) {
        deps.logger.info(`${TAG} turn ${turn.id} is owned by another reconciler or HITL recovery`);
      }
    } catch (err) {
      deps.logger.error(`${TAG} failed to finalize stranded turn ${turn.id}:`, err);
    }
  }

  await resetStrandedSessions(deps, strandedSessionIds);

  const redispatchComplete = processQueuedRedispatches(deps, queuedCandidates, leaseContext, {
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
      const updated = await deps.db.stageAssistantMessageUpdate(
        message.id,
        repairedToolCalls,
        repairedParts,
      );
      if (!updated) {
        throw new Error(`Assistant message ${message.id} disappeared during tool-state repair`);
      }
      await publishMessageCanonicalState(deps, updated);
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

  const userMessage = messages[userMessageIndex]!;
  const frames = await deps.db.getTurnFrames(turn.id);
  const emitTurnStarted = !frames.some((frame) => frame.type === 'RUN_STARTED');
  const messagesForTurn = messages.slice(0, userMessageIndex + 1);
  const republishUserMessage = turn.mode !== 'background' && !hasDurableUserMessage(frames, turn.userMessageId)
    ? {
        turnId: turn.id,
        agentId: turn.agentId,
        conversationId: turn.conversationId,
        messageId: turn.userMessageId,
        content: userMessage.content,
        timestamp: userMessage.createdAt,
      }
    : null;

  return {
    turn,
    order: userMessageIndex,
    republishUserMessage,
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
    ...(turn.sandboxSessionId ? { sandboxSessionId: turn.sandboxSessionId } : {}),
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
  leaseContext: TurnLeaseContext,
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

    const conversationsOwnedElsewhere = new Set<string>();
    for (const candidate of agentCandidates) {
      const conversationId = candidate.turn.conversationId ?? '';
      if (conversationsOwnedElsewhere.has(conversationId)) {
        continue;
      }
      try {
        const outcome = await withTurnReconciliationLease(
          deps,
          candidate.turn.id,
          leaseContext,
          async (signal) => {
            const authorized = await deps.db.authorizeQueuedTurnRedispatch(
              candidate.turn.id,
              leaseContext.ownerId,
              leaseContext.now(),
            );
            if (!authorized) {
              deps.logger.info(
                `${TAG} queued turn ${candidate.turn.id} lost fenced redispatch authorization`,
              );
              return false;
            }
            try {
              signal.throwIfAborted();
              if (candidate.republishUserMessage) {
                await deps.eventBus.emitAsync('user.message', candidate.republishUserMessage);
              }
              signal.throwIfAborted();
              await deps.redispatchQueuedTurn!(candidate.params, signal);
              signal.throwIfAborted();
              callbacks.onRedispatched();
              return true;
            } catch (err) {
              if (signal.aborted) {
                deps.logger.warn(
                  `${TAG} queued turn ${candidate.turn.id} redispatch stopped after lease loss`,
                );
                return false;
              }
              deps.logger.error(`${TAG} queued turn ${candidate.turn.id} redispatch failed:`, err);
              const errorMessage = err instanceof Error ? err.message : String(err);
              const finalized = await failStrandedTurn(deps, candidate.turn, errorMessage);
              if (finalized) {
                callbacks.onFailed();
              }
              return true;
            }
          },
        );
        if (!outcome.claimed || !outcome.value) {
          conversationsOwnedElsewhere.add(conversationId);
          if (!outcome.claimed) {
            deps.logger.info(
              `${TAG} queued turn ${candidate.turn.id} is owned by another reconciler or HITL recovery`,
            );
          }
        }
      } catch (err) {
        conversationsOwnedElsewhere.add(conversationId);
        deps.logger.error(`${TAG} failed to claim queued turn ${candidate.turn.id} for redispatch:`, err);
      }
    }
  }));
}

async function withTurnReconciliationLease<T>(
  deps: TurnReconcilerDeps,
  turnId: string,
  context: TurnLeaseContext,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<{ claimed: false } | { claimed: true; value: T }> {
  const claimedAt = context.now();
  const claimed = await deps.db.claimTurnReconciliationLease({
    turnId,
    ownerId: context.ownerId,
    claimedAt,
    leaseExpiresAt: claimedAt + context.leaseMs,
  });
  if (!claimed) {
    return { claimed: false };
  }

  const leaseAbortController = new AbortController();
  let leaseExpiresAt = claimed.leaseExpiresAt;
  let stopped = false;
  let renewalInFlight = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const loseLease = (message: string, cause?: unknown) => {
    if (leaseAbortController.signal.aborted) {
      return;
    }
    const error = new Error(message, cause === undefined ? undefined : { cause });
    leaseAbortController.abort(error);
    deps.logger.warn(`${TAG} ${message}`);
  };

  const armExpiryWatchdog = () => {
    if (stopped || leaseAbortController.signal.aborted) {
      return;
    }
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    const remainingMs = leaseExpiresAt - context.now();
    if (remainingMs <= 0) {
      loseLease(`reconciliation lease expired for turn ${turnId}`);
      return;
    }
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      if (context.now() >= leaseExpiresAt) {
        loseLease(`reconciliation lease expired for turn ${turnId}`);
        return;
      }
      armExpiryWatchdog();
    }, remainingMs);
    unrefTimer(expiryTimer);
  };

  armExpiryWatchdog();
  const heartbeat = setInterval(() => {
    if (stopped || renewalInFlight || leaseAbortController.signal.aborted) {
      return;
    }
    renewalInFlight = true;
    const renewedAt = context.now();
    void deps.db.renewTurnReconciliationLease(
      turnId,
      context.ownerId,
      renewedAt,
      renewedAt + context.leaseMs,
    ).then((renewed) => {
      if (!renewed && !stopped) {
        loseLease(`lost reconciliation lease for turn ${turnId}`);
        return;
      }
      if (renewed) {
        leaseExpiresAt = renewed.leaseExpiresAt;
        armExpiryWatchdog();
      }
    }).catch((err: unknown) => {
      if (!stopped) {
        deps.logger.warn(`${TAG} failed to renew reconciliation lease for turn ${turnId}:`, err);
        if (context.now() >= leaseExpiresAt) {
          loseLease(`reconciliation lease expired for turn ${turnId}`, err);
        }
      }
    }).finally(() => {
      renewalInFlight = false;
    });
  }, context.heartbeatMs);
  unrefTimer(heartbeat);

  try {
    return { claimed: true, value: await action(leaseAbortController.signal) };
  } finally {
    stopped = true;
    clearInterval(heartbeat);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    try {
      await deps.db.releaseTurnReconciliationLease(turnId, context.ownerId);
    } catch (err) {
      deps.logger.warn(
        `${TAG} failed to release reconciliation lease for turn ${turnId}; it will expire:`,
        err,
      );
    }
  }
}
