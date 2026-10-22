import type { DatabaseRepository } from '../database/repository.js';
import type { TurnSelect } from '../database/types.js';
import type {
  EventMap,
  EventPersistenceContext,
  TypedEventBus,
} from '../events/bus.js';
import {
  publishMessageCanonicalState,
} from './message-publisher.js';
import { mapMessagesToInternal } from './routes/agent-helpers.js';
import type { RedispatchQueuedTurnParams } from './turn-startup-service.js';
import {
  TOOL_CALL_INTERRUPTED_ERROR,
  TURN_ERROR_ORCHESTRATOR_RESTART,
  turnErrorTakeoverUnavailable,
  type TurnFinalizer,
} from './turn-finalizer.js';
import { newDeliveryOwnerId } from './instance-identity.js';
import type { TurnTakeoverResult } from './turn-takeover.js';
import {
  acquireSandboxSessionLifecycleOperation,
  type SandboxSessionLifecycleOperationGuard,
} from './sandbox-session-lifecycle-operation.js';
import type { TurnDeliveryFence } from './turn-delivery-fence.js';
import { acquireTurnDeliveryLease } from './turn-delivery-lease.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

interface TurnReconcilerDeps {
  db: Pick<
    DatabaseRepository,
    | 'getOpenTurnsStartedBefore'
    | 'getTurn'
    | 'getPendingInterruptForTurn'
    | 'getMessages'
    | 'stageAssistantMessageUpdate'
    | 'claimTurnDeliveryLease'
    | 'renewTurnDeliveryLease'
    | 'isTurnDeliveryFenceCurrent'
    | 'wasTurnFinalizedByDeliveryFence'
    | 'releaseTurnDeliveryLease'
    | 'getSandboxSession'
    | 'claimSandboxSessionLifecycleOperation'
    | 'renewSandboxSessionLifecycleOperation'
    | 'markSandboxSessionLifecycleOperationExecuting'
    | 'cancelSandboxSessionLifecycleOperation'
  >;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  finalizer: TurnFinalizer;
  logger: Logger;
  redispatchQueuedTurn?: (
    params: RedispatchQueuedTurnParams,
    signal: AbortSignal,
  ) => Promise<void>;
  resetStrandedSession?: (
    sessionId: string,
    lifecycleOperation: SandboxSessionLifecycleOperationGuard,
  ) => Promise<void>;
  /**
   * Crash takeover (ADR 024): re-attach a running turn to the sandbox that is
   * still executing it. Called with the turn's delivery lease held. Without
   * it, running turns are closed with restart copy as before.
   */
  adoptRunningTurn?: (
    turn: TurnSelect,
    lease: { fence: TurnDeliveryFence; signal: AbortSignal },
  ) => Promise<TurnTakeoverResult>;
}

export interface TurnAdoptionSummary {
  adopted: number;
  failed: number;
  skipped: number;
}

interface TurnReconciliationResult {
  failed: number;
  skippedHitlParked: number;
  redispatched: number;
  redispatchComplete: Promise<void>;
  /** Running turns handed to crash takeover; they finish in the background. */
  adopting: number;
  adoptionComplete: Promise<TurnAdoptionSummary>;
}

interface TurnReconciliationOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  ownerId?: string;
  now?: () => number;
  /** Claim leases of a dead earlier boot of this instance without waiting. */
  previousBootTakeover?: { instancePrefix: string; ownBootPrefix: string };
  /** How long takeover keeps trying to claim a lease held elsewhere. */
  adoptionClaimWaitMs?: number;
  adoptionPollMs?: number;
}

interface TurnLeaseContext {
  leaseMs: number;
  heartbeatMs: number;
  ownerId: string;
  now: () => number;
  previousBootTakeover?: { instancePrefix: string; ownBootPrefix: string };
}

export interface ConversationToolCallRepairDeps {
  db: Pick<DatabaseRepository, 'getMessages' | 'stageAssistantMessageUpdate'>;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  logger: Logger;
}

interface ConversationToolCallRepairOptions {
  turnId: string;
  deliveryFence: TurnDeliveryFence;
  signal?: AbortSignal;
}

const TAG = '[TurnReconciler]';
const DEFAULT_RECONCILIATION_LEASE_MS = 60_000;
const DEFAULT_RECONCILIATION_HEARTBEAT_MS = 20_000;
/** A dead owner's lease lapses within its 60 s lease; allow renewal jitter. */
const DEFAULT_ADOPTION_CLAIM_WAIT_MS = 90_000;
const DEFAULT_ADOPTION_POLL_MS = 2_000;

type ToolCallish = { status?: unknown; error?: unknown; type?: unknown };

interface QueuedRedispatchCandidate {
  turn: TurnSelect;
  params: Omit<RedispatchQueuedTurnParams, 'deliveryContext'>;
  recoveryUserMessage?: EventMap['user.message'];
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
 * Startup turn reconciliation (ADR-014, ctx-nm3o, ADR 024). Any turn open at
 * boot that started before boot lost its in-process owner — unless it is
 * parked on a durable HITL interrupt (pending/timed_out row), which the
 * durable resume path (WS-B) owns.
 *
 * Running turns whose sandbox may still be executing them are handed to
 * crash takeover (`adoptRunningTurn`): the successor claims the delivery
 * lease with a higher fence, re-attaches to the sandbox's delivery journal,
 * and finishes the turn in the background. Turns that cannot be re-attached,
 * and every other stranded turn, are failed with cause-accurate copy, and
 * their persisted messages are repaired so no terminal turn retains
 * 'running' tool calls in either the toolCalls or parts projection.
 */
export async function reconcileStrandedTurnsOnStartup(
  deps: TurnReconcilerDeps,
  bootTimeMs: number,
  options: TurnReconciliationOptions = {},
): Promise<TurnReconciliationResult> {
  const leaseContext: TurnLeaseContext = {
    leaseMs: options.leaseMs ?? DEFAULT_RECONCILIATION_LEASE_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_RECONCILIATION_HEARTBEAT_MS,
    ownerId: options.ownerId ?? newDeliveryOwnerId(),
    now: options.now ?? Date.now,
    ...(options.previousBootTakeover
      ? { previousBootTakeover: options.previousBootTakeover }
      : {}),
  };
  if (leaseContext.leaseMs <= 0 || leaseContext.heartbeatMs <= 0) {
    throw new Error('Turn delivery lease and heartbeat durations must be positive');
  }
  if (leaseContext.heartbeatMs >= leaseContext.leaseMs) {
    throw new Error('Turn reconciliation heartbeat must be shorter than its lease');
  }

  const openTurns = await deps.db.getOpenTurnsStartedBefore(bootTimeMs);
  let failed = 0;
  let skippedHitlParked = 0;
  let redispatched = 0;
  const strandedTurns: TurnSelect[] = [];
  const adoptionCandidates: TurnSelect[] = [];
  const queuedCandidates: QueuedRedispatchCandidate[] = [];

  for (const turn of openTurns) {
    try {
      const interrupt = await deps.db.getPendingInterruptForTurn(turn.id);
      if (interrupt && (interrupt.status === 'pending' || interrupt.status === 'timed_out')) {
        skippedHitlParked++;
        deps.logger.info(`${TAG} turn ${turn.id} is parked on a durable HITL interrupt; leaving open for resume`);
        continue;
      }

      if (turn.status === 'queued' && turn.conversationId && turn.userMessageId) {
        // ctx-z5k0: queued turns are durable dispatcher work, not boot debt.
        // The TurnDispatcher drains them after listen(); executing them here
        // was the boot barrier (server down until the backlog completed).
        // Queued rows missing their conversation/user message fall through
        // to the stranded path below and are failed honestly.
        continue;
      }

      if (
        deps.adoptRunningTurn
        && turn.status === 'running'
        && turn.sandboxSessionId
        && turn.conversationId
      ) {
        adoptionCandidates.push(turn);
        continue;
      }

      strandedTurns.push(turn);
    } catch (err) {
      deps.logger.error(`${TAG} failed to reconcile stranded turn ${turn.id}:`, err);
    }
  }

  for (const turn of strandedTurns) {
    try {
      const outcome = await withTurnDeliveryLease(
        deps,
        turn.id,
        leaseContext,
        (signal, fence) => failStrandedTurnWithReset(
          deps,
          turn,
          signal,
          fence,
          TURN_ERROR_ORCHESTRATOR_RESTART,
        ),
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

  const adoptionComplete = adoptRunningTurns(deps, adoptionCandidates, leaseContext, {
    claimWaitMs: options.adoptionClaimWaitMs ?? DEFAULT_ADOPTION_CLAIM_WAIT_MS,
    pollMs: options.adoptionPollMs ?? DEFAULT_ADOPTION_POLL_MS,
  });

  const redispatchComplete = processQueuedRedispatches(deps, queuedCandidates, leaseContext, {
    onRedispatched: () => {
      redispatched++;
    },
    onFailed: () => {
      failed++;
    },
  });
  await redispatchComplete;

  if (failed > 0 || skippedHitlParked > 0 || redispatched > 0 || adoptionCandidates.length > 0) {
    deps.logger.info(
      `${TAG} startup reconciliation closed ${failed} stranded turn(s), redispatched ${redispatched} queued turn(s), `
      + `left ${skippedHitlParked} HITL-parked turn(s) open, taking over ${adoptionCandidates.length} running turn(s)`,
    );
  }

  return {
    failed,
    skippedHitlParked,
    redispatched,
    redispatchComplete,
    adopting: adoptionCandidates.length,
    adoptionComplete,
  };
}

/**
 * Close one stranded turn under its delivery lease: repair running tool
 * calls, finalize with `error`, then reset its sandbox session so nothing
 * keeps executing the abandoned turn. Returns true when this call finalized.
 */
async function failStrandedTurnWithReset(
  deps: TurnReconcilerDeps,
  turn: TurnSelect,
  signal: AbortSignal,
  fence: TurnDeliveryFence,
  error: string,
): Promise<boolean> {
  const shouldResetSession = Boolean(
    deps.resetStrandedSession
    && turn.status !== 'queued'
    && turn.sandboxSessionId,
  );
  const observedSession = shouldResetSession
    ? await deps.db.getSandboxSession(turn.sandboxSessionId!)
    : undefined;
  const lifecycleOperation =
    shouldResetSession
    && observedSession?.status === 'ACTIVE'
      ? await acquireSandboxSessionLifecycleOperation(
          { db: deps.db, logger: deps.logger },
          observedSession.id,
          'reset',
          {
            expectedActiveGeneration: {
              restoreFenceToken: observedSession.restoreFenceToken,
              containerId: observedSession.containerId,
            },
            allowedTurnDelivery: {
              turnId: turn.id,
              fence,
            },
          },
        )
      : undefined;
  if (
    shouldResetSession
    && !lifecycleOperation
  ) {
    deps.logger.info(
      `${TAG} sandbox session ${turn.sandboxSessionId} is owned by ` +
      'another lifecycle worker; leaving its stranded turn open',
    );
    return false;
  }

  try {
    const finalized = await failStrandedTurn(
      deps,
      turn,
      error,
      {
        signal,
        fence,
        ...(lifecycleOperation && turn.sandboxSessionId
          ? {
              lifecycleReset: {
                sandboxSessionId: turn.sandboxSessionId,
                fence: lifecycleOperation.fence,
              },
            }
          : {}),
      },
    );
    if (finalized && lifecycleOperation && turn.sandboxSessionId) {
      if (!await lifecycleOperation.markExecuting()) {
        throw new Error(
          `Sandbox lifecycle reset ${turn.sandboxSessionId} ` +
          'lost ownership after stranded turn finalization',
        );
      }
      try {
        await deps.resetStrandedSession!(
          turn.sandboxSessionId,
          lifecycleOperation,
        );
      } catch (err) {
        deps.logger.error(
          `${TAG} failed to reset stranded session ` +
          `${turn.sandboxSessionId}:`,
          err,
        );
      }
    }
    return finalized;
  } finally {
    await lifecycleOperation?.stop();
  }
}

async function adoptRunningTurns(
  deps: TurnReconcilerDeps,
  candidates: TurnSelect[],
  leaseContext: TurnLeaseContext,
  timing: { claimWaitMs: number; pollMs: number },
): Promise<TurnAdoptionSummary> {
  const summary: TurnAdoptionSummary = { adopted: 0, failed: 0, skipped: 0 };
  if (!deps.adoptRunningTurn || candidates.length === 0) {
    return summary;
  }
  deps.logger.info(
    `${TAG} taking over ${candidates.length} running turn(s) whose sandboxes may still be executing them`,
  );
  const outcomes = await Promise.all(candidates.map(async (turn) => {
    try {
      return await adoptRunningTurn(deps, turn, leaseContext, timing);
    } catch (err) {
      deps.logger.error(`${TAG} takeover of turn ${turn.id} failed:`, err);
      return 'skipped' as const;
    }
  }));
  for (const outcome of outcomes) {
    summary[outcome] += 1;
  }
  deps.logger.info(
    `${TAG} crash takeover finished: adopted=${summary.adopted}, failed=${summary.failed}, skipped=${summary.skipped}`,
  );
  return summary;
}

async function adoptRunningTurn(
  deps: TurnReconcilerDeps,
  turn: TurnSelect,
  leaseContext: TurnLeaseContext,
  timing: { claimWaitMs: number; pollMs: number },
): Promise<keyof TurnAdoptionSummary> {
  const deadline = leaseContext.now() + timing.claimWaitMs;
  let waitingLogged = false;
  while (true) {
    try {
      const outcome = await withTurnDeliveryLease(
        deps,
        turn.id,
        leaseContext,
        async (signal, fence): Promise<keyof TurnAdoptionSummary> => {
          let reason: string;
          try {
            const result = await deps.adoptRunningTurn!(turn, { fence, signal });
            if (result.outcome === 'adopted') {
              return 'adopted';
            }
            reason = result.reason;
          } catch (err) {
            if (signal.aborted) {
              deps.logger.warn(`${TAG} lost the lease while taking over turn ${turn.id}`);
              return 'skipped';
            }
            deps.logger.error(`${TAG} takeover of turn ${turn.id} failed:`, err);
            reason = err instanceof Error ? err.message : String(err);
          }
          deps.logger.warn(`${TAG} turn ${turn.id} cannot be re-attached (${reason}); closing it`);
          const finalized = await failStrandedTurnWithReset(
            deps,
            turn,
            signal,
            fence,
            turnErrorTakeoverUnavailable(reason),
          );
          return finalized ? 'failed' : 'skipped';
        },
      );
      if (outcome.claimed) {
        return outcome.value;
      }
    } catch (err) {
      deps.logger.error(`${TAG} takeover of turn ${turn.id} failed:`, err);
      return 'skipped';
    }

    const current = await deps.db.getTurn(turn.id);
    if (!current || current.completedAt != null || current.status !== 'running') {
      return 'skipped';
    }
    if (leaseContext.now() >= deadline) {
      deps.logger.info(
        `${TAG} turn ${turn.id} is still owned elsewhere after ${timing.claimWaitMs}ms; leaving it to its owner`,
      );
      return 'skipped';
    }
    if (!waitingLogged) {
      waitingLogged = true;
      deps.logger.info(
        `${TAG} turn ${turn.id} is leased by another orchestrator; waiting for the lease to lapse before taking over`,
      );
    }
    await delay(timing.pollMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function repairConversationRunningToolCalls(
  deps: ConversationToolCallRepairDeps,
  conversationId: string,
  options: ConversationToolCallRepairOptions,
): Promise<void> {
  const messages = await deps.db.getMessages(conversationId);
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (message.turnId !== options.turnId) {
      continue;
    }
    const repairedToolCalls = repairRunningEntries(message.toolCalls, false);
    const repairedParts = repairRunningEntries(message.parts, true);
    if (repairedToolCalls || repairedParts) {
      options.signal?.throwIfAborted();
      const updated = await deps.db.stageAssistantMessageUpdate(
        message.id,
        repairedToolCalls,
        repairedParts,
        options.deliveryFence,
      );
      if (!updated) {
        throw new Error(
          `Turn ${options.turnId} lost delivery ownership during tool-state repair`,
        );
      }
      options.signal?.throwIfAborted();
      const persistenceContext: EventPersistenceContext = {
        deliveryFence: options.deliveryFence,
      };
      await publishMessageCanonicalState(deps, updated, persistenceContext);
      options.signal?.throwIfAborted();
    }
  }
}

async function failStrandedTurn(
  deps: TurnReconcilerDeps,
  turn: TurnSelect,
  error = TURN_ERROR_ORCHESTRATOR_RESTART,
  ownership?: {
    signal: AbortSignal;
    fence: TurnDeliveryFence;
    lifecycleReset?: {
      sandboxSessionId: string;
      fence: {
        ownerId: string;
        fenceToken: number;
      };
    };
  },
): Promise<boolean> {
  ownership?.signal.throwIfAborted();
  if (turn.conversationId) {
    if (!ownership) {
      throw new Error(`Stranded turn ${turn.id} repair requires delivery ownership`);
    }
    await repairConversationRunningToolCalls(deps, turn.conversationId, {
      turnId: turn.id,
      deliveryFence: ownership.fence,
      signal: ownership.signal,
    });
  }
  ownership?.signal.throwIfAborted();

  const result = await deps.finalizer.finalize({
    turnId: turn.id,
    agentId: turn.agentId,
    conversationId: turn.conversationId ?? '',
    ...(turn.sandboxSessionId ? { sandboxSessionId: turn.sandboxSessionId } : {}),
    status: 'error',
    error,
    durationMs: Date.now() - turn.startedAt,
    ...(ownership ? { expectedDeliveryFence: ownership.fence } : {}),
    ...(ownership?.lifecycleReset
      ? { lifecycleReset: ownership.lifecycleReset }
      : {}),
  });
  return result.finalized;
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
        const outcome = await withTurnDeliveryLease(
          deps,
          candidate.turn.id,
          leaseContext,
          async (signal, fence) => {
            try {
              signal.throwIfAborted();
              await deps.redispatchQueuedTurn!({
                ...candidate.params,
                deliveryContext: {
                  fence,
                  ...(candidate.recoveryUserMessage
                    ? { userMessage: candidate.recoveryUserMessage }
                    : {}),
                },
              }, signal);
              const fenceStillCurrent = !signal.aborted
                && await deps.db.isTurnDeliveryFenceCurrent(
                  candidate.turn.id,
                  fence,
                );
              if (!fenceStillCurrent) {
                const finalizedByFence =
                  await deps.db.wasTurnFinalizedByDeliveryFence(
                    candidate.turn.id,
                    fence,
                  );
                if (!finalizedByFence) {
                  deps.logger.warn(
                    signal.aborted
                      ? `${TAG} queued turn ${candidate.turn.id} redispatch stopped after lease loss`
                      : `${TAG} queued turn ${candidate.turn.id} lost its fence before redispatch completed`,
                  );
                  return false;
                }
              }
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
              const finalized = await failStrandedTurn(deps, candidate.turn, errorMessage, {
                signal,
                fence,
              });
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

async function withTurnDeliveryLease<T>(
  deps: TurnReconcilerDeps,
  turnId: string,
  context: TurnLeaseContext,
  action: (
    signal: AbortSignal,
    fence: TurnDeliveryFence,
  ) => Promise<T>,
): Promise<{ claimed: false } | { claimed: true; value: T }> {
  const lease = await acquireTurnDeliveryLease(
    { db: deps.db, logger: deps.logger },
    turnId,
    {
      ownerId: context.ownerId,
      leaseMs: context.leaseMs,
      heartbeatMs: context.heartbeatMs,
      now: context.now,
      ...(context.previousBootTakeover
        ? { previousBootTakeover: context.previousBootTakeover }
        : {}),
    },
  );
  if (!lease) {
    return { claimed: false };
  }

  try {
    return {
      claimed: true,
      value: await action(lease.signal, lease.fence),
    };
  } finally {
    await lease.release();
  }
}
