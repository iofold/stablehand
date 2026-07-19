import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  DeliverTurnRequestSchema,
  type SessionEvent as ProtoSessionEvent,
} from '@ctxmill/proto/sandbox/v1';

import type { TypedEventBus } from '../../events/bus.js';
import { protoSessionEventToCustom } from '../../sandbox/proto-convert.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { ContainerLifecyclePolicy } from '../container-lifecycle-policy.js';
import type { InterruptManager } from '../interrupt.js';
import type { SessionEvent as CustomSessionEvent } from '../session-turn-service.js';
import { TURN_CANCELLED_MESSAGE } from '../turn-cancellation.js';
import { unrefTimer } from '../../util/timing.js';
import { SessionRecoveryCoordinator } from './session-recovery-coordinator.js';
import type { SessionStateStore } from './session-state-store.js';
import {
  AsyncChannel,
  type Logger,
  type SessionRecord,
} from './types.js';
import { ConcurrencyLimitError } from './concurrency-limit-error.js';
import { SessionStatusCoordinator } from './session-status-coordinator.js';
import {
  turnErrorSandboxConnectionLost,
  turnErrorSandboxStreamEndedWithoutCompletion,
} from '../turn-finalizer.js';

const TAG = '[SandboxSessionManager]';
const MAX_DRAIN_ITERATIONS = 100;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

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
  onStaleContainer: (
    sessionId: string,
    conversationId: string,
    agentDef: AgentDefinition,
    agentId?: string,
  ) => Promise<SessionRecord>;
  onSessionRebound?: (event: {
    turnId: string;
    previousSessionId: string;
    sessionId: string;
  }) => Promise<void>;
  onTurnActive?: (turnId: string) => void | Promise<void>;
  executeDeliverTurn: (
    sessionId: string,
    messages: Message[],
    turnId: string,
    onSessionRebound?: (nextSessionId: string) => void,
    signal?: AbortSignal,
  ) => AsyncGenerator<CustomSessionEvent>;
}

export interface ConcurrencyReservation {
  agentId: string;
  id: string;
  release(): void;
}

export interface SessionTurnStartOptions {
  suppressEvent?: boolean;
}

export class SessionTurnOrchestrator {
  private readonly startupReservationsByAgent = new Map<string, Set<string>>();

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
    if (!options?.suppressEvent) {
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

  completeTurn(
    sessionId: string,
    turnId: string,
    _agentId: string,
    _conversationId: string,
    _status: 'completed' | 'error' | 'cancelled',
    _durationMs: number,
    _error?: string,
    _usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number },
  ): void {
    this.deps.stateStore.clearTurnController(sessionId, turnId);
    this.deps.stateStore.markTurnInactive(sessionId, turnId);
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
    signal?: AbortSignal,
  ): AsyncGenerator<CustomSessionEvent> {
    signal?.throwIfAborted();
    const record = this.deps.stateStore.getSessionById(sessionId);
    const conversationId = record?.conversationId;
    if (!conversationId) {
      throw new Error(`Session ${sessionId} not found in active sessions`);
    }

    const shouldQueue = await this.deps.stateStore.withConversationLock(conversationId, async () => {
      if (this.deps.stateStore.isActiveTurn(sessionId)) {
        return true;
      }
      await this.markTurnActive(sessionId, turnId);
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
      const entry = { messages, turnId, channel, signal };
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

    let currentSessionId = sessionId;
    const onSessionRebound = (nextSessionId: string) => {
      currentSessionId = nextSessionId;
    };

    try {
      yield* this.executeDeliverTurn(
        sessionId,
        messages,
        turnId,
        false,
        onSessionRebound,
        signal,
      );
    } finally {
      await this.deps.stateStore.withConversationLock(conversationId, async () => {
        this.deps.stateStore.markTurnInactive(currentSessionId, turnId);
        if (currentSessionId !== sessionId) {
          this.deps.stateStore.markTurnInactive(sessionId, turnId);
        }
        await this.drainCoalescedQueue(currentSessionId);
      });
    }
  }

  async *executeDeliverTurn(
    sessionId: string,
    messages: Message[],
    turnId: string,
    _retried = false,
    onSessionRebound?: (nextSessionId: string) => void,
    signal?: AbortSignal,
  ): AsyncGenerator<CustomSessionEvent> {
    const record = this.deps.stateStore.getSessionById(sessionId);
    if (!record) {
      throw new Error(`Session ${sessionId} not found for turn delivery`);
    }

    await this.deps.lifecyclePolicy.cancelIdleTimeout(sessionId);

    this.deps.logger.debug(
      `${TAG} delivering turn ${turnId} to session ${sessionId} (${messages.length} message(s))`,
    );

    const request = create(DeliverTurnRequestSchema, {
      sessionId,
      turnId,
      messages: toProtoMessages(messages),
    });
    let eventCount = 0;
    let sawTerminalFrame = false;

    try {
      signal?.throwIfAborted();
      const stream: AsyncIterable<ProtoSessionEvent> = signal
        ? record.grpcClient!.deliverTurn(request, { signal })
        : record.grpcClient!.deliverTurn(request);
      const turnTimeout = this.deps.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const abortController = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => abortController.abort(),
        turnTimeout,
      );
      unrefTimer(timeoutId);
      let interruptActive = false;

      let iterator: AsyncIterator<ProtoSessionEvent> | undefined;
      try {
        iterator = stream[Symbol.asyncIterator]();
        const turnAbortSignal = this.deps.stateStore.getTurnAbortSignal(sessionId, turnId);
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
              timeoutId = setTimeout(() => abortController.abort(), turnTimeout);
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
      if (signal?.aborted) {
        this.deps.logger.info(
          `${TAG} externally fenced turn ${turnId} for session ${sessionId}`,
        );
        await this.settleTurnActive(sessionId, record);
        return;
      }
      if (err instanceof Error && err.message === `Turn ${turnId} cancelled for session ${sessionId}`) {
        this.deps.logger.info(`${TAG} turn ${turnId} cancelled for session ${sessionId}`);
        await this.settleTurnActive(sessionId, record);
        return;
      }

      const isAbort = err instanceof ConnectError && err.code === Code.Aborted;

      if (!_retried && eventCount === 0 && isAbort) {
        this.deps.logger.warn(
          `${TAG} stream aborted before any events for turn ${turnId} on session ${sessionId}, retrying once`,
        );
        yield* this.executeDeliverTurn(
          sessionId,
          messages,
          turnId,
          true,
          undefined,
          signal,
        );
        return;
      }

      if (!_retried && eventCount > 0 && isAbort) {
        this.deps.logger.warn(
          `${TAG} stream aborted mid-turn (${eventCount} events received) for turn ${turnId} on session ${sessionId} — connection dropped during tool execution`,
        );
        await this.deps.statusCoordinator.transition({
          sessionId,
          fromStatus: record.status,
          toStatus: 'TERMINATED',
          clearRuntime: true,
        });
        this.deps.stateStore.deleteSession(record.conversationId);
      }

      const agentDef = this.deps.stateStore.getAgentDef(record.conversationId);
      if (SessionRecoveryCoordinator.isStaleContainerError(err) && agentDef && !_retried) {
        const failureSummary = summarizeTurnDeliveryFailure(err);
        this.deps.logger.warn(
          `${TAG} stale container for session ${sessionId}, recovering and retrying turn: ${failureSummary}`,
        );
        await this.deps.statusCoordinator.transition({
          sessionId,
          fromStatus: record.status,
          toStatus: 'TERMINATED',
          extra: { lastRestoreError: failureSummary },
          clearRuntime: true,
        });
        this.deps.stateStore.deleteSession(record.conversationId);
        const newRecord = await this.deps.onStaleContainer(
          sessionId,
          record.conversationId,
          agentDef,
          record.agentId,
        );
        this.deps.stateStore.rebindTurnRuntime(sessionId, newRecord.sessionId, turnId);
        await this.deps.onSessionRebound?.({
          turnId,
          previousSessionId: sessionId,
          sessionId: newRecord.sessionId,
        });
        onSessionRebound?.(newRecord.sessionId);
        yield* this.executeDeliverTurn(
          newRecord.sessionId,
          messages,
          turnId,
          true,
          onSessionRebound,
          signal,
        );
        return;
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
      const errorMessage = `Sandbox turn ${turnId} completed without emitting any events for session ${sessionId}`;
      this.deps.logger.warn(`${TAG} ${errorMessage}`);
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

      await this.markTurnActive(sessionId, nextEntry.turnId);
      let currentSessionId = sessionId;
      const onSessionRebound = (nextSessionId: string) => {
        currentSessionId = nextSessionId;
      };
      let drainReboundQueue = false;
      try {
        const turnAbortSignal = this.deps.stateStore.getTurnAbortSignal(sessionId, nextEntry.turnId);
        if (turnAbortSignal?.aborted) {
          throw new Error(`Turn ${nextEntry.turnId} cancelled for session ${sessionId}`);
        }
        nextEntry.signal?.throwIfAborted();
        for await (const event of this.deps.executeDeliverTurn(
          sessionId,
          nextEntry.messages,
          nextEntry.turnId,
          onSessionRebound,
          nextEntry.signal,
        )) {
          nextEntry.channel.push(event);
        }
        nextEntry.channel.close();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        nextEntry.channel.fail(error);
      } finally {
        this.deps.stateStore.clearTurnController(currentSessionId, nextEntry.turnId);
        this.deps.stateStore.markTurnInactive(currentSessionId, nextEntry.turnId);
        if (currentSessionId !== sessionId) {
          this.deps.stateStore.clearTurnController(sessionId, nextEntry.turnId);
          this.deps.stateStore.markTurnInactive(sessionId, nextEntry.turnId);
          drainReboundQueue = true;
        }
      }
      if (drainReboundQueue) {
        await this.drainCoalescedQueue(currentSessionId);
        return;
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

  scheduleIdleTimeoutForActiveSession(sessionId: string, record: SessionRecord): void {
    this.deps.lifecyclePolicy.scheduleIdleTimeout(sessionId, record.containerId, {
      onCheckpoint: async (sid) => {
        await this.deps.onCheckpoint(sid);
      },
      onContainerGone: async (sid) => {
        await this.handleContainerGone(sid);
      },
    });
  }

  private async handleContainerGone(sessionId: string): Promise<void> {
    this.deps.logger.warn(`${TAG} container gone for session ${sessionId}, marking TERMINATED`);
    const record = this.deps.stateStore.getSessionById(sessionId);
    if (record) {
      await this.deps.statusCoordinator.transition({
        sessionId,
        fromStatus: record.status,
        toStatus: 'TERMINATED',
        clearRuntime: true,
      });
      this.deps.stateStore.deleteSession(record.conversationId);
      this.deps.stateStore.deleteAgentDef(record.conversationId);
    }
    this.deps.stateStore.deleteQueue(sessionId);
    this.deps.stateStore.markTurnInactive(sessionId);
  }

  private async markTurnActive(sessionId: string, turnId: string): Promise<void> {
    this.deps.stateStore.markTurnActive(sessionId, turnId);
    try {
      await this.deps.onTurnActive?.(turnId);
    } catch (err) {
      this.deps.logger.error(`${TAG} failed to mark turn ${turnId} active durably:`, err);
    }
  }
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
