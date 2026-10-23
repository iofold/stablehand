import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  AttachTurnRequestSchema,
  CancelTurnRequestSchema,
  DeliverTurnRequestSchema,
  RenewTurnDeliveryCapabilityRequestSchema,
  type SessionEvent as ProtoSessionEvent,
  type TurnDeliveryCapability,
} from '@stablehand/proto/sandbox/v1';

import type { EventMap, TypedEventBus } from '../../events/bus.js';
import { protoSessionEventToCustom } from '../../sandbox/proto-convert.js';
import type { Message } from '@stablehand/sandbox-daemon';
import type { SandboxSessionActiveGeneration } from '../../database/repository.js';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { InterruptManager } from '../interrupt.js';
import type { SandboxSessionLifecycleOperationGuard } from '../sandbox-session-lifecycle-operation.js';
import type { SessionEvent as CustomSessionEvent } from '../session-turn-service.js';
import { TURN_CANCELLED_MESSAGE } from '../turn-cancellation.js';
import { unrefTimer } from '../../util/timing.js';
import { SessionRecoveryCoordinator } from './session-recovery-coordinator.js';
import type { SessionStateStore } from './session-state-store.js';
import {
  AsyncChannel,
  type Logger,
  type SessionRecord,
  type TurnDeliveryOptions,
} from './types.js';
import { ConcurrencyLimitError } from './concurrency-limit-error.js';
import { SessionStatusCoordinator } from './session-status-coordinator.js';
import {
  TURN_ERROR_SANDBOX_ALREADY_ENDED_TURN,
  turnErrorSandboxConnectionLost,
  turnErrorSandboxStreamEndedWithoutCompletion,
} from '../turn-finalizer.js';
import type {
  TurnDeliveryFence,
  TurnDeliveryContext,
} from '../turn-delivery-fence.js';
import { TurnAttachUnavailableError } from '../turn-attach-error.js';

const TAG = '[SandboxSessionManager]';
const MAX_DRAIN_ITERATIONS = 100;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CAPABILITY_REFRESH_MS = 10_000;
const MIN_CAPABILITY_REFRESH_MS = 100;
const CANCEL_TURN_TIMEOUT_MS = 2_000;

function summarizeTurnDeliveryFailure(err: unknown): string {
  if (err instanceof ConnectError) {
    return `ConnectError code=${err.code} message=${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  if (typeof signal.reason === 'string') {
    return new Error(signal.reason);
  }
  return new Error(fallback);
}

export interface SessionTurnOrchestratorDeps {
  stateStore: SessionStateStore;
  statusCoordinator: SessionStatusCoordinator;
  lifecyclePolicy: Pick<ContainerLifecyclePolicy, 'cancelIdleTimeout' | 'scheduleIdleTimeout'>;
  eventBus?: TypedEventBus;
  interruptManager?: InterruptManager;
  logger: Logger;
  config: {
    maxQueuedMessages: number;
    turnTimeoutMs?: number;
    maxConcurrentSessionsPerAgent?: number;
  };
  onCheckpoint: (sessionId: string) => Promise<void>;
  reserveSessionReset: (event: {
    turnId: string;
    sessionId: string;
    deliveryFence: TurnDeliveryFence;
  }) => Promise<SandboxSessionLifecycleOperationGuard | undefined>;
  executeReservedSessionReset: (
    sessionId: string,
    lifecycleOperation: SandboxSessionLifecycleOperationGuard,
  ) => Promise<void>;
  resetSession: (sessionId: string) => Promise<void>;
  onTurnActive?: (event: {
    turnId: string;
    sessionId: string;
    expectedActiveGeneration: SandboxSessionActiveGeneration;
    deliveryFence?: TurnDeliveryFence;
  }) => boolean | void | Promise<boolean | void>;
  verifyActiveGeneration?: (
    sessionId: string,
    expectedActiveGeneration: SandboxSessionActiveGeneration,
  ) => boolean | Promise<boolean>;
  verifyTurnDeliveryFence?: (
    turnId: string,
    fence: TurnDeliveryFence,
  ) => boolean | Promise<boolean>;
  issueTurnDeliveryCapability: (input: {
    turnId: string;
    sandboxSessionId: string;
    agentId: string;
    expectedActiveGeneration: SandboxSessionActiveGeneration;
    expectedDeliveryFence: TurnDeliveryFence;
  }) => Promise<TurnDeliveryCapability | undefined>;
  executeDeliverTurn: (
    sessionId: string,
    messages: Message[],
    turnId: string,
    options?: TurnDeliveryOptions,
  ) => AsyncGenerator<CustomSessionEvent>;
}

export interface ConcurrencyReservation {
  agentId: string;
  id: string;
  release(): void;
}

export interface SessionTurnStartOptions {
  suppressEvent?: boolean;
  deliveryContext?: TurnDeliveryContext;
  deliveryAdmission?: 'activate' | 'continuation';
}

export class SessionTurnOrchestrator {
  private readonly startupReservationsByAgent = new Map<string, Set<string>>();
  private readonly pendingSessionResets = new Map<string, {
    sessionId: string;
    lifecycleOperation: SandboxSessionLifecycleOperationGuard;
  }>();
  private readonly deliveryContexts = new Map<string, {
    context: TurnDeliveryContext;
    requiresActivation: boolean;
    turnStarted?: EventMap['turn.started'];
  }>();

  constructor(private readonly deps: SessionTurnOrchestratorDeps) {}

  startTurn(
    sessionId: string,
    turnId: string,
    agentId: string,
    conversationId: string,
    mode: 'interactive' | 'background',
    taskDescription?: string,
    options?: SessionTurnStartOptions,
  ): AbortSignal {
    const record = this.deps.stateStore.getSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const controller = new AbortController();
    this.deps.stateStore.registerTurnController(sessionId, turnId, controller);
    if (options?.deliveryContext) {
      this.deliveryContexts.set(turnId, {
        context: options.deliveryContext,
        requiresActivation: options.deliveryAdmission !== 'continuation',
        ...(options.deliveryAdmission === 'continuation'
          ? {}
          : {
              turnStarted: {
                turnId,
                sandboxSessionId: sessionId,
                agentId,
                conversationId,
                mode,
                taskDescription: taskDescription ?? '',
                timestamp: Date.now(),
              },
            }),
      });
    } else if (!options?.suppressEvent) {
      this.deps.eventBus?.emit('turn.started', {
        turnId,
        sandboxSessionId: sessionId,
        agentId,
        conversationId,
        mode,
        taskDescription: taskDescription ?? '',
        timestamp: Date.now(),
      });
    }
    return controller.signal;
  }

  async completeTurn(
    sessionId: string,
    turnId: string,
    _agentId: string,
    _conversationId: string,
    _status: 'completed' | 'error' | 'cancelled',
    _durationMs: number,
    _error?: string,
    _usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number },
  ): Promise<void> {
    this.deliveryContexts.delete(turnId);
    this.deps.stateStore.clearTurnController(sessionId, turnId);
    this.deps.stateStore.markTurnInactive(sessionId, turnId);
    const pendingReset = this.pendingSessionResets.get(turnId);
    if (!pendingReset) {
      return;
    }
    this.pendingSessionResets.delete(turnId);
    try {
      await this.deps.executeReservedSessionReset(
        pendingReset.sessionId,
        pendingReset.lifecycleOperation,
      );
    } finally {
      await pendingReset.lifecycleOperation.stop();
    }
  }

  async abandonTurnDelivery(sessionId: string, turnId: string): Promise<void> {
    this.deliveryContexts.delete(turnId);
    this.deps.stateStore.clearTurnController(sessionId, turnId);
    this.deps.stateStore.markTurnInactive(sessionId, turnId);
    const pendingReset = this.pendingSessionResets.get(turnId);
    if (!pendingReset) {
      return;
    }
    this.pendingSessionResets.delete(turnId);
    try {
      await pendingReset.lifecycleOperation.cancel();
    } finally {
      await pendingReset.lifecycleOperation.stop();
    }
  }

  getPendingSessionReset(
    turnId: string,
  ): { sandboxSessionId: string; fence: { ownerId: string; fenceToken: number } } | undefined {
    const pendingReset = this.pendingSessionResets.get(turnId);
    return pendingReset
      ? {
          sandboxSessionId: pendingReset.sessionId,
          fence: pendingReset.lifecycleOperation.fence,
        }
      : undefined;
  }

  getTurnDeliveryFence(turnId: string): TurnDeliveryFence | undefined {
    const fence = this.getDeliveryFence(turnId);
    return fence ? { ...fence } : undefined;
  }

  cancelCurrentTurn(sessionId: string, turnId?: string): boolean {
    const targetTurnId = turnId ?? this.deps.stateStore.getActiveTurnId(sessionId);
    if (!targetTurnId) {
      return false;
    }

    const queue = this.deps.stateStore.getQueue(sessionId);
    const queuedIndex = queue?.findIndex((entry) => entry.turnId === targetTurnId) ?? -1;
    if (queue && queuedIndex >= 0) {
      const [entry] = queue.splice(queuedIndex, 1);
      entry?.channel.fail(new Error(TURN_CANCELLED_MESSAGE));
      this.deliveryContexts.delete(targetTurnId);
      this.deps.stateStore.clearTurnController(sessionId, targetTurnId);
      return true;
    }

    const activeTurnId = this.deps.stateStore.getActiveTurnId(sessionId);
    if (activeTurnId && activeTurnId !== targetTurnId) {
      return false;
    }

    return this.deps.stateStore.abortTurn(sessionId, targetTurnId);
  }

  getAbortSignal(sessionId: string, turnId?: string): AbortSignal | undefined {
    const targetTurnId = turnId ?? this.deps.stateStore.getActiveTurnId(sessionId);
    return targetTurnId ? this.deps.stateStore.getTurnAbortSignal(sessionId, targetTurnId) : undefined;
  }

  checkConcurrencyLimit(agentId: string, options?: { excludeReservationId?: string }): void {
    const maxConcurrentSessionsPerAgent = this.deps.config.maxConcurrentSessionsPerAgent ?? 3;
    const activeForAgent = this.deps.stateStore.getAllSessions().filter((session) =>
      session.agentId === agentId && session.status === 'ACTIVE');
    const reservationCount = this.countStartupReservations(agentId, options?.excludeReservationId);
    if (activeForAgent.length + reservationCount >= maxConcurrentSessionsPerAgent) {
      throw new ConcurrencyLimitError(agentId, maxConcurrentSessionsPerAgent, 5);
    }
  }

  reserveConcurrencySlot(agentId: string): ConcurrencyReservation {
    this.checkConcurrencyLimit(agentId);

    const id = randomUUID();
    let reservations = this.startupReservationsByAgent.get(agentId);
    if (!reservations) {
      reservations = new Set<string>();
      this.startupReservationsByAgent.set(agentId, reservations);
    }
    reservations.add(id);

    return {
      agentId,
      id,
      release: () => this.releaseConcurrencyReservation(agentId, id),
    };
  }

  private releaseConcurrencyReservation(agentId: string, id: string): void {
    const reservations = this.startupReservationsByAgent.get(agentId);
    if (!reservations) {
      return;
    }

    reservations.delete(id);
    if (reservations.size === 0) {
      this.startupReservationsByAgent.delete(agentId);
    }
  }

  private countStartupReservations(agentId: string, excludeReservationId?: string): number {
    const reservations = this.startupReservationsByAgent.get(agentId);
    if (!reservations) {
      return 0;
    }

    return excludeReservationId && reservations.has(excludeReservationId)
      ? reservations.size - 1
      : reservations.size;
  }

  async *deliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
    options?: TurnDeliveryOptions,
  ): AsyncGenerator<CustomSessionEvent> {
    const signal = options?.signal;
    const turnSecrets = options?.turnSecrets
      ? { ...options.turnSecrets }
      : undefined;
    const attach = options?.attach;
    signal?.throwIfAborted();
    const record = this.deps.stateStore.getSessionById(sessionId);
    const conversationId = record?.conversationId;
    if (!conversationId) {
      throw new Error(`Session ${sessionId} not found in active sessions`);
    }

    const shouldQueue = await this.deps.stateStore.withConversationLock(conversationId, async () => {
      signal?.throwIfAborted();
      if (this.deps.stateStore.isActiveTurn(sessionId)) {
        return true;
      }
      await this.markTurnActive(sessionId, turnId, signal);
      return false;
    });

    if (shouldQueue) {
      const queue = this.deps.stateStore.getOrCreateQueue(sessionId);
      if (queue.length >= this.deps.config.maxQueuedMessages) {
        throw new Error(
          `Session ${sessionId} turn queue is full (max=${this.deps.config.maxQueuedMessages})`,
        );
      }
      const channel = new AsyncChannel<CustomSessionEvent>();
      const entry = {
        messages,
        turnId,
        ...(turnSecrets ? { turnSecrets } : {}),
        ...(attach ? { attach } : {}),
        channel,
        signal,
      };
      queue.push(entry);
      this.deps.logger.debug(
        `${TAG} session ${sessionId}: buffering turn ${turnId} (queue depth: ${queue.length})`,
      );
      const onAbort = signal
        ? () => {
          const queuedIndex = queue.indexOf(entry);
          if (queuedIndex < 0) {
            return;
          }
          queue.splice(queuedIndex, 1);
          channel.fail(abortReason(
            signal,
            `Turn ${turnId} cancelled for session ${sessionId}`,
          ));
        }
        : undefined;
      if (signal && onAbort) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (signal?.aborted) {
        onAbort?.();
      }
      try {
        yield* channel.generator();
        return;
      } finally {
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort);
        }
      }
    }

    try {
      yield* this.executeDeliverTurn(
        sessionId,
        messages,
        turnId,
        {
          ...(signal ? { signal } : {}),
          ...(turnSecrets ? { turnSecrets } : {}),
          ...(attach ? { attach } : {}),
        },
      );
    } finally {
      await this.deps.stateStore.withConversationLock(conversationId, async () => {
        this.deps.stateStore.markTurnInactive(sessionId, turnId);
        await this.drainCoalescedQueue(sessionId);
      });
    }
  }

  async *executeDeliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
    options?: TurnDeliveryOptions,
  ): AsyncGenerator<CustomSessionEvent> {
    yield* this.executeDeliverTurnAttempt(
      sessionId,
      messages,
      turnId,
      options,
      false,
    );
  }

  private async *executeDeliverTurnAttempt(
    sessionId: string,
    messages: Message[],
    turnId: string,
    options: TurnDeliveryOptions | undefined,
    retried: boolean,
  ): AsyncGenerator<CustomSessionEvent> {
    const signal = options?.signal;
    const turnSecrets = options?.turnSecrets;
    const attach = options?.attach;
    signal?.throwIfAborted();
    const record = this.deps.stateStore.getSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found for turn delivery`);
    }

    await this.verifyDeliveryFence(turnId);
    signal?.throwIfAborted();
    await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);

    this.deps.logger.debug(
      `${TAG} delivering turn ${turnId} to session ${sessionId} (${messages.length} message(s))`,
    );

    const request = create(DeliverTurnRequestSchema, {
      sessionId,
      turnId,
      messages: toProtoMessages(messages),
      ...(turnSecrets ? { turnSecrets: { ...turnSecrets } } : {}),
    });
    let eventCount = 0;
    let sawTerminalFrame = false;
    const turnAbortSignal =
      this.deps.stateStore.getTurnAbortSignal(sessionId, turnId);
    const deliveryFence = this.getDeliveryFence(turnId);
    const expectedActiveGeneration: SandboxSessionActiveGeneration = {
      restoreFenceToken: record.restoreFenceToken,
      containerId: record.containerId || null,
    };
    const initialCapability = deliveryFence
      ? await this.deps.issueTurnDeliveryCapability({
        turnId,
        sandboxSessionId: sessionId,
        agentId: record.agentId,
        expectedActiveGeneration,
        expectedDeliveryFence: deliveryFence,
      })
      : undefined;
    if (deliveryFence && !initialCapability) {
      throw new Error(`Turn ${turnId} lost delivery capability admission`);
    }
    if (initialCapability) {
      request.deliveryCapability = initialCapability;
    }
    let currentCapability = initialCapability;
    let timedOut = false;
    const capabilityLossController = new AbortController();
    const renewalStopController = new AbortController();
    let capabilityRenewal: Promise<void> | undefined;

    try {
      signal?.throwIfAborted();
      await this.verifyDeliveryFence(turnId);
      signal?.throwIfAborted();
      this.assertCapabilityUnexpired(initialCapability, turnId);
      const deliverySignal = initialCapability
        ? signal
          ? AbortSignal.any([signal, capabilityLossController.signal])
          : capabilityLossController.signal
        : signal;
      const callOptions = deliverySignal ? { signal: deliverySignal } : undefined;
      const stream: AsyncIterable<ProtoSessionEvent> = attach
        ? record.grpcClient!.attachTurn(
          create(AttachTurnRequestSchema, {
            sessionId,
            turnId,
            ...(initialCapability ? { deliveryCapability: initialCapability } : {}),
            afterDeliverySeq: BigInt(attach.afterDeliverySeq),
          }),
          callOptions,
        )
        : record.grpcClient!.deliverTurn(request, callOptions);
      const turnTimeout = this.deps.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const abortController = new AbortController();
      const onTurnTimeout = (): void => {
        timedOut = true;
        abortController.abort();
      };
      let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
        onTurnTimeout,
        turnTimeout,
      );
      unrefTimer(timeoutId);
      let interruptActive = false;

      let iterator: AsyncIterator<ProtoSessionEvent> | undefined;
      try {
        iterator = stream[Symbol.asyncIterator]();
        if (initialCapability && deliveryFence) {
          capabilityRenewal = this.maintainTurnDeliveryCapability({
            record,
            turnId,
            expectedActiveGeneration,
            expectedDeliveryFence: deliveryFence,
            initialCapability,
            stopSignal: renewalStopController.signal,
            lossController: capabilityLossController,
            onRenewed: (capability) => {
              currentCapability = capability;
            },
          });
        }
        const timeoutError = () =>
          new Error(`Turn ${turnId} timed out after ${turnTimeout}ms for session ${sessionId}`);
        const cancellationError = () => new Error(`Turn ${turnId} cancelled for session ${sessionId}`);
        signal?.throwIfAborted();
        if (turnAbortSignal?.aborted) {
          throw cancellationError();
        }
        const waitForNext = async () => {
          let onTimeoutAbort: (() => void) | null = null;
          let onTurnAbort: (() => void) | null = null;
          let onExternalAbort: (() => void) | null = null;
          const onAbortError = new Promise<never>((_, reject) => {
            const listener = () => {
              reject(timeoutError());
            };
            onTimeoutAbort = listener;

            if (abortController.signal.aborted) {
              listener();
              return;
            }

            abortController.signal.addEventListener('abort', listener, { once: true });
          });
          const onTurnAbortError = new Promise<never>((_, reject) => {
            if (!turnAbortSignal) {
              return;
            }

            const listener = () => {
              reject(cancellationError());
            };
            onTurnAbort = listener;

            if (turnAbortSignal.aborted) {
              listener();
              return;
            }

            turnAbortSignal.addEventListener('abort', listener, { once: true });
          });
          const onExternalAbortError = new Promise<never>((_, reject) => {
            if (!signal) {
              return;
            }

            const listener = () => {
              reject(abortReason(
                signal,
                `Turn ${turnId} cancelled for session ${sessionId}`,
              ));
            };
            onExternalAbort = listener;

            if (signal.aborted) {
              listener();
              return;
            }

            signal.addEventListener('abort', listener, { once: true });
          });

          try {
            return await Promise.race<IteratorResult<ProtoSessionEvent>>([
              iterator!.next(),
              onAbortError,
              onTurnAbortError,
              onExternalAbortError,
            ]);
          } finally {
            if (onTimeoutAbort) {
              abortController.signal.removeEventListener('abort', onTimeoutAbort);
            }
            if (turnAbortSignal && onTurnAbort) {
              turnAbortSignal.removeEventListener('abort', onTurnAbort);
            }
            if (signal && onExternalAbort) {
              signal.removeEventListener('abort', onExternalAbort);
            }
          }
        };

        while (true) {
          const next = await waitForNext();
          if (next.done) {
            break;
          }

          const event = next.value;
          if (event.payload.case === 'turnCompleted' || event.payload.case === 'turnFailed') {
            sawTerminalFrame = true;
          }
          const converted = protoSessionEventToCustom(event, turnId);
          if (converted) {
            if (converted.type === 'ag_ui_event' && converted.event.type === 'INTERRUPT_REQUESTED') {
              if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
              }
              interruptActive = true;
              this.deps.logger.debug(
                `${TAG} INTERRUPT_REQUESTED detected for session ${sessionId}, turn timeout suspended`,
              );
            } else if (interruptActive) {
              interruptActive = false;
              timeoutId = setTimeout(onTurnTimeout, turnTimeout);
              unrefTimer(timeoutId);
              this.deps.logger.debug(
                `${TAG} interrupt resolved for session ${sessionId}, turn timeout re-armed`,
              );
            }

            eventCount++;
            yield converted;
          }
        }
      } finally {
        renewalStopController.abort();
        void capabilityRenewal;
        // ADR 025: a dropped stream only detaches the sandbox delivery, so an
        // intentional stop (user cancel, turn timeout) must be explicit. A
        // lost lease is not a stop: the successor re-attaches.
        if ((turnAbortSignal?.aborted || timedOut) && currentCapability) {
          await this.cancelSandboxTurn(
            record,
            turnId,
            currentCapability,
            timedOut ? `turn timed out after ${turnTimeout}ms` : 'turn cancelled',
          );
        }
        if (iterator?.return) {
          void iterator.return().catch((returnErr: unknown) => {
            this.deps.logger.debug(`${TAG} iterator.return() failed for turn ${turnId}:`, returnErr);
          });
        }
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    } catch (err) {
      if (capabilityLossController.signal.aborted) {
        this.deps.logger.info(
          `${TAG} delivery capability lost for turn ${turnId} on session ${sessionId}`,
        );
        return;
      }
      if (signal?.aborted) {
        if (turnAbortSignal?.aborted) {
          this.deps.logger.info(
            `${TAG} turn ${turnId} cancelled for session ${sessionId}`,
          );
          await this.settleTurnActive(sessionId, record);
        } else {
          this.deps.logger.info(
            `${TAG} externally fenced turn ${turnId} for session ${sessionId}`,
          );
        }
        return;
      }
      if (err instanceof Error && err.message === `Turn ${turnId} cancelled for session ${sessionId}`) {
        this.deps.logger.info(`${TAG} turn ${turnId} cancelled for session ${sessionId}`);
        await this.settleTurnActive(sessionId, record);
        return;
      }

      if (attach && eventCount === 0) {
        throw new TurnAttachUnavailableError(
          turnId,
          sessionId,
          `Could not re-attach to turn ${turnId} in sandbox session ${sessionId}: `
          + summarizeTurnDeliveryFailure(err),
          { cause: err },
        );
      }

      const isAbort = err instanceof ConnectError && err.code === Code.Aborted;

      if (!retried && !attach && eventCount === 0 && isAbort) {
        this.deps.logger.warn(
          `${TAG} stream aborted before any events for turn ${turnId} on session ${sessionId}, retrying once`,
        );
        yield* this.executeDeliverTurnAttempt(
          sessionId,
          messages,
          turnId,
          {
            ...(signal ? { signal } : {}),
            ...(turnSecrets ? { turnSecrets } : {}),
          },
          true,
        );
        return;
      }

      if (
        (eventCount > 0 && isAbort)
        || SessionRecoveryCoordinator.isStaleContainerError(err)
      ) {
        const failureSummary = summarizeTurnDeliveryFailure(err);
        const resetReserved = await this.reserveSessionReset(
          sessionId,
          turnId,
        );
        this.deps.logger.warn(
          `${TAG} sandbox session ${sessionId} failed during turn ${turnId}; `
          + `${resetReserved ? 'reserved a fenced reset' : 'reset reservation unavailable'}: `
          + failureSummary,
        );
      }

      const errorMessage = isAbort && eventCount > 0
        ? turnErrorSandboxConnectionLost(eventCount)
        : err instanceof ConnectError
          ? err.message
          : err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);

      this.deps.logger.error(`${TAG} turn ${turnId} failed on session ${sessionId}:`, err);

      yield {
        type: 'turn_failed' as const,
        turnId,
        errorMessage,
      };
      return;
    }

    if (eventCount === 0) {
      // A bare TurnCompleted frame is the sandbox acknowledging a duplicate
      // delivery: it already ended this turn on its own and ran nothing now
      // (ctx-2jp0). Say so instead of reporting an empty stream.
      const errorMessage = sawTerminalFrame
        ? TURN_ERROR_SANDBOX_ALREADY_ENDED_TURN
        : `Sandbox turn ${turnId} completed without emitting any events for session ${sessionId}`;
      this.deps.logger.warn(
        sawTerminalFrame
          ? `${TAG} sandbox session ${sessionId} acknowledged turn ${turnId} as already completed without running it`
          : `${TAG} ${errorMessage}`,
      );
      await this.settleTurnActive(sessionId, record);
      yield {
        type: 'turn_failed' as const,
        turnId,
        errorMessage,
      };
      return;
    }

    if (!sawTerminalFrame) {
      const errorMessage = turnErrorSandboxStreamEndedWithoutCompletion(eventCount);
      this.deps.logger.warn(`${TAG} turn ${turnId} on session ${sessionId} ${errorMessage}`);
      const liveRecord = this.deps.stateStore.getSessionById(sessionId);
      if (liveRecord) {
        await this.settleTurnActive(sessionId, liveRecord);
      }
      yield {
        type: 'turn_failed' as const,
        turnId,
        errorMessage,
      };
      return;
    }

    await this.settleTurnActive(sessionId, record);

    this.deps.logger.debug(`${TAG} turn ${turnId} completed for session ${sessionId}`);
  }

  async drainCoalescedQueue(sessionId: string): Promise<void> {
    let iterations = 0;
    while (iterations < MAX_DRAIN_ITERATIONS) {
      const queue = this.deps.stateStore.getQueue(sessionId);
      if (!queue || queue.length === 0) return;

      iterations++;
      const nextEntry = queue.shift();
      if (!nextEntry) {
        return;
      }

      this.deps.logger.debug(
        `${TAG} draining queued turn ${nextEntry.turnId} (remaining depth: ${queue.length}) for session ${sessionId}`,
      );

      try {
        nextEntry.signal?.throwIfAborted();
        await this.markTurnActive(sessionId, nextEntry.turnId, nextEntry.signal);
        const turnAbortSignal = this.deps.stateStore.getTurnAbortSignal(sessionId, nextEntry.turnId);
        if (turnAbortSignal?.aborted) {
          throw new Error(`Turn ${nextEntry.turnId} cancelled for session ${sessionId}`);
        }
        nextEntry.signal?.throwIfAborted();
        for await (const event of this.deps.executeDeliverTurn(
          sessionId,
          nextEntry.messages,
          nextEntry.turnId,
          {
            ...(nextEntry.signal ? { signal: nextEntry.signal } : {}),
            ...(nextEntry.turnSecrets ? { turnSecrets: nextEntry.turnSecrets } : {}),
            ...(nextEntry.attach ? { attach: nextEntry.attach } : {}),
          },
        )) {
          nextEntry.channel.push(event);
        }
        nextEntry.channel.close();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        nextEntry.channel.fail(error);
      } finally {
        this.deps.stateStore.clearTurnController(sessionId, nextEntry.turnId);
        this.deps.stateStore.markTurnInactive(sessionId, nextEntry.turnId);
      }
    }

    if (iterations >= MAX_DRAIN_ITERATIONS) {
      this.deps.logger.warn(
        `${TAG} drain loop hit safety limit (${MAX_DRAIN_ITERATIONS}) for session ${sessionId} — remaining items dropped`,
      );
      const remaining = this.deps.stateStore.getQueue(sessionId);
      if (remaining) {
        const error = new Error(`Turn queue drain exceeded ${MAX_DRAIN_ITERATIONS} iterations`);
        for (const entry of remaining.splice(0)) {
          entry.channel.fail(error);
        }
      }
    }
  }

  private async settleTurnActive(sessionId: string, record: SessionRecord): Promise<void> {
    await this.deps.statusCoordinator.transition({
      sessionId,
      fromStatus: record.status,
      toStatus: 'ACTIVE',
    });
    this.scheduleIdleTimeoutForActiveSession(sessionId, record);
  }

  scheduleIdleTimeoutForActiveSession(
    sessionId: string,
    record: SessionRecord,
    options?: { resumeFromLastActivity?: boolean },
  ): void {
    this.deps.lifecyclePolicy.scheduleIdleTimeout(sessionId, record.containerId, {
      onCheckpoint: async (sid) => {
        await this.deps.onCheckpoint(sid);
      },
      onContainerGone: async (sid) => {
        await this.handleContainerGone(sid);
      },
      onForceTerminate: async (sid) => {
        this.deps.logger.error(
          `${TAG} forcing a fenced reset for session ${sid}: `
          + 'repeated un-checkpointable failures (ctx-vsf8)',
        );
        await this.deps.resetSession(sid);
      },
    }, options);
  }

  private async handleContainerGone(sessionId: string): Promise<void> {
    this.deps.logger.warn(
      `${TAG} container gone for session ${sessionId}; requesting a fenced reset`,
    );
    await this.deps.resetSession(sessionId);
  }

  private async markTurnActive(
    sessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const record = this.deps.stateStore.getSessionById(sessionId);
    if (!record || record.status !== 'ACTIVE') {
      throw new Error(
        `Sandbox session ${sessionId} has no ACTIVE runtime for turn ${turnId}`,
      );
    }
    const expectedActiveGeneration: SandboxSessionActiveGeneration = {
      restoreFenceToken: record.restoreFenceToken,
      containerId: record.containerId || null,
    };
    const delivery = this.deliveryContexts.get(turnId);
    const fence = delivery?.context.fence;
    if (delivery?.requiresActivation === false) {
      await this.verifyDeliveryFence(turnId);
      const current = await this.deps.verifyActiveGeneration?.(
        sessionId,
        expectedActiveGeneration,
      );
      if (current === false) {
        throw new Error(
          `Turn ${turnId} references a stale runtime generation for sandbox session ${sessionId}`,
        );
      }
    } else {
      const activated = await this.deps.onTurnActive?.({
        turnId,
        sessionId,
        expectedActiveGeneration,
        ...(fence ? { deliveryFence: fence } : {}),
      });
      if (activated === false) {
        throw new Error(`Turn ${turnId} lost durable delivery admission`);
      }
    }
    signal?.throwIfAborted();

    if (delivery) {
      if (!this.deps.eventBus) {
        throw new Error(`Turn ${turnId} fenced delivery requires a durable event bus`);
      }
      await this.verifyDeliveryFence(turnId);
      signal?.throwIfAborted();
      if (delivery.context.userMessage) {
        await this.deps.eventBus.emitAsync('user.message', delivery.context.userMessage, {
          deliveryFence: delivery.context.fence,
        });
      }
      await this.verifyDeliveryFence(turnId);
      signal?.throwIfAborted();
      if (delivery.turnStarted) {
        await this.deps.eventBus.emitAsync(
          'turn.started',
          {
            ...delivery.turnStarted,
            sandboxSessionId: sessionId,
          },
          {
            deliveryFence: delivery.context.fence,
          },
        );
        await this.verifyDeliveryFence(turnId);
        signal?.throwIfAborted();
      }
    }

    this.deps.stateStore.markTurnActive(sessionId, turnId);
  }

  private getDeliveryFence(turnId: string): TurnDeliveryFence | undefined {
    return this.deliveryContexts.get(turnId)?.context.fence;
  }

  private async reserveSessionReset(
    sessionId: string,
    turnId: string,
  ): Promise<boolean> {
    if (this.pendingSessionResets.has(turnId)) {
      return true;
    }
    const deliveryFence = this.getDeliveryFence(turnId);
    if (!deliveryFence) {
      this.deps.logger.warn(
        `${TAG} refusing an unfenced reset for session ${sessionId}, turn ${turnId}`,
      );
      return false;
    }

    await this.verifyDeliveryFence(turnId);
    const lifecycleOperation = await this.deps.reserveSessionReset({
      turnId,
      sessionId,
      deliveryFence,
    });
    if (!lifecycleOperation) {
      return false;
    }
    try {
      await this.verifyDeliveryFence(turnId);
    } catch (err) {
      try {
        await lifecycleOperation.cancel();
      } finally {
        await lifecycleOperation.stop();
      }
      throw err;
    }
    this.pendingSessionResets.set(turnId, {
      sessionId,
      lifecycleOperation,
    });
    return true;
  }

  private async verifyDeliveryFence(turnId: string): Promise<void> {
    const fence = this.getDeliveryFence(turnId);
    if (!fence || !this.deps.verifyTurnDeliveryFence) {
      return;
    }
    if (!await this.deps.verifyTurnDeliveryFence(turnId, fence)) {
      throw new Error(`Turn ${turnId} lost reconciliation fence`);
    }
  }

  private async cancelSandboxTurn(
    record: SessionRecord,
    turnId: string,
    capability: TurnDeliveryCapability,
    reason: string,
  ): Promise<void> {
    if (!record.grpcClient) {
      return;
    }
    try {
      await record.grpcClient.cancelTurn(
        create(CancelTurnRequestSchema, {
          sessionId: record.sessionId,
          turnId,
          deliveryCapability: capability,
          reason,
        }),
        { timeoutMs: CANCEL_TURN_TIMEOUT_MS },
      );
    } catch (error) {
      // Older sandbox images treat the dropped stream as the cancel.
      this.deps.logger.debug(
        `${TAG} CancelTurn for turn ${turnId} on session ${record.sessionId} failed: `
        + summarizeTurnDeliveryFailure(error),
      );
    }
  }

  private assertCapabilityUnexpired(
    capability: TurnDeliveryCapability | undefined,
    turnId: string,
  ): void {
    if (!capability) {
      return;
    }
    const deadline = Number(capability.leaseExpiresAtMs);
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) {
      throw new Error(`Turn ${turnId} delivery capability expired before dispatch`);
    }
  }

  private async maintainTurnDeliveryCapability(input: {
    record: SessionRecord;
    turnId: string;
    expectedActiveGeneration: SandboxSessionActiveGeneration;
    expectedDeliveryFence: TurnDeliveryFence;
    initialCapability: TurnDeliveryCapability;
    stopSignal: AbortSignal;
    lossController: AbortController;
    onRenewed?: (capability: TurnDeliveryCapability) => void;
  }): Promise<void> {
    let deadline = Number(input.initialCapability.leaseExpiresAtMs);
    while (!input.stopSignal.aborted && !input.lossController.signal.aborted) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        input.lossController.abort(
          new Error(`Turn ${input.turnId} delivery capability expired`),
        );
        return;
      }
      const refreshDelayMs = Math.max(
        MIN_CAPABILITY_REFRESH_MS,
        Math.min(
          DEFAULT_CAPABILITY_REFRESH_MS,
          Math.floor(remainingMs / 3),
        ),
      );
      if (!await waitForCapabilityRefresh(
        refreshDelayMs,
        input.stopSignal,
      )) {
        return;
      }

      try {
        const capability = await this.deps.issueTurnDeliveryCapability({
          turnId: input.turnId,
          sandboxSessionId: input.record.sessionId,
          agentId: input.record.agentId,
          expectedActiveGeneration: input.expectedActiveGeneration,
          expectedDeliveryFence: input.expectedDeliveryFence,
        });
        if (input.stopSignal.aborted) {
          return;
        }
        if (!capability) {
          input.lossController.abort(
            new Error(`Turn ${input.turnId} lost delivery capability admission`),
          );
          return;
        }
        this.assertCapabilityUnexpired(capability, input.turnId);
        const response =
          await input.record.grpcClient!.renewTurnDeliveryCapability(
            create(RenewTurnDeliveryCapabilityRequestSchema, {
              sessionId: input.record.sessionId,
              turnId: input.turnId,
              deliveryCapability: capability,
            }),
            { signal: input.stopSignal },
          );
        if (!response.renewed) {
          input.lossController.abort(
            new Error(`Sandbox rejected turn ${input.turnId} capability renewal`),
          );
          return;
        }
        deadline = Number(capability.leaseExpiresAtMs);
        input.onRenewed?.(capability);
      } catch (error) {
        if (input.stopSignal.aborted) {
          return;
        }
        if (Date.now() >= deadline) {
          input.lossController.abort(
            new Error(
              `Turn ${input.turnId} delivery capability expired during renewal`,
              { cause: error },
            ),
          );
          return;
        }
        this.deps.logger.warn(
          `${TAG} turn ${input.turnId} capability renewal failed; retrying before expiry:`,
          error,
        );
      }
    }
  }
}

async function waitForCapabilityRefresh(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    unrefTimer(timer);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toProtoMessages(messages: Message[]): Array<{
  id: string;
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
}> {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    toolCalls:
      message.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        argumentsJson: JSON.stringify(toolCall.arguments),
      })) ?? [],
  }));
}
