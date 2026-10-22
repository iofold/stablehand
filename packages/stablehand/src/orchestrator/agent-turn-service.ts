import type { AgentSessionEvent } from '../events/types.js';
import type { ApiTokenUsage, MessageCommittedEvent } from '@stablehand/shared';
import {
  BUDGET_REACHED_CODE,
  turnStopReasonMessage,
  type TurnStopReason,
} from '@stablehand/contracts';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';
import type { DatabaseRepository } from '../database/repository.js';
import type { MessageSelect } from '../database/types.js';
import type {
  EventMap,
  EventName,
  EventPersistenceContext,
  TypedEventBus,
} from '../events/bus.js';
import type { SessionTurnExecutor } from './session-turn-service.js';
import type { SandboxSessionManager, SessionRecord } from './sandbox-session-manager.js';
import type { ConcurrencyReservation } from './session-manager/session-turn-orchestrator.js';
import { sanitizeDbText } from '../util/sanitize.js';
import { isA2UIRenderTool } from '../a2ui/extract.js';
import type { TurnSecrets } from './session-manager/turn-secrets.js';
import { TURN_CANCELLED_MESSAGE, isTurnCancelled } from './turn-cancellation.js';
import {
  TOOL_CALL_INTERRUPTED_ERROR,
  TURN_ERROR_EMPTY_MODEL_OUTPUT,
  TURN_ERROR_RUNNING_TOOL_CALLS_AT_END,
  TurnFinalizer,
} from './turn-finalizer.js';
import { repairConversationRunningToolCalls } from './turn-reconciler.js';
import { publishMessageCanonicalState } from './message-publisher.js';
import type { TurnDeliveryContext } from './turn-delivery-fence.js';
import type { CanonicalLog } from './canonical/canonical-log.js';
import { readDeliveryStamp, type DeliveryStamp } from './delivery-stamp.js';
import { TurnAttachUnavailableError } from './turn-attach-error.js';
import {
  acquireTurnDeliveryLease,
  type TurnDeliveryLeaseGuard,
} from './turn-delivery-lease.js';
import {
  performanceInstrumentation,
  type PerformanceMeasurement,
  type PerformanceOutcome,
  type PerformanceRecorder,
} from '../observability/performance.js';
import {
  budgetStopReason,
  type GatewayBudgetRefusalReport,
  type SessionGatewayKeyManager,
} from '../cost-control/session-gateway-keys.js';

/** Error code the sandbox puts on a RUN_ERROR when the gateway refused a call for budget. */
const MODEL_GATEWAY_BUDGET_REFUSAL_CODE = 'model_gateway_budget_exceeded';
// Refusal text from sandboxes that predate the typed error code.
const BUDGET_REFUSAL_TEXT = /Stablehand spend cap reached|Budget has been exceeded!|reached its spend cap/;

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The gateway budget refusal a RUN_ERROR reports, if it reports one. */
export function readGatewayBudgetRefusal(event: Record<string, unknown>): GatewayBudgetRefusalReport | null {
  const message = typeof event.error === 'string'
    ? event.error
    : typeof event.message === 'string'
      ? event.message
      : '';
  if (event.code !== MODEL_GATEWAY_BUDGET_REFUSAL_CODE && !BUDGET_REFUSAL_TEXT.test(message)) {
    return null;
  }
  const details = typeof event.details === 'object' && event.details !== null
    ? event.details as Record<string, unknown>
    : {};
  return {
    spentUsd: finiteOrNull(details.spentUsd),
    capUsd: finiteOrNull(details.capUsd),
  };
}

const INDIVIDUALLY_HANDLED = new Set([
  'MESSAGE_COMMITTED',
  'TEXT_MESSAGE_CONTENT',
  'TOOL_CALL_START',
  'TOOL_CALL_RESULT',
  'RUN_ERROR',
  'RUN_FINISHED',
  'INTERRUPT_REQUESTED',
]);

/** Cap on tool results carried in `tool_call.completed`, keeping the event log bounded. */
const TOOL_RESULT_EVENT_MAX_LENGTH = 500;

/**
 * a2ui-render results are exempt from the cap: the canonical projector reparses
 * this string to build the `stablehand.a2ui.render` block, so a truncated payload
 * fails JSON.parse and the render block is dropped without any error surfacing.
 * TableView and chart payloads routinely exceed the cap.
 */
export function toolResultForEvent(toolName: string, result: unknown): string {
  const serialized = String(result);
  return isA2UIRenderTool(toolName) ? serialized : serialized.slice(0, TOOL_RESULT_EVENT_MAX_LENGTH);
}

/** Extended AG-UI event fields used when extracting tool/message data. */
interface TextContentEvent {
  type: 'TEXT_MESSAGE_CONTENT';
  delta: string;
  messageId?: string;
}

interface ToolCallStartEvent {
  type: 'TOOL_CALL_START';
  toolCallName?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}

interface ToolCallResultEvent {
  type: 'TOOL_CALL_RESULT';
  result: unknown;
  toolCallId?: string;
  toolCallName?: string;
  toolName?: string;
  durationMs?: number;
}

/**
 * Tool name carried by a TOOL_CALL_START/TOOL_CALL_RESULT event. The daemon
 * converter (protoAgentEventToAGUI) emits the AG-UI protocol key
 * `toolCallName`; `toolName` is accepted as a fallback for emitters that use
 * the internal spelling (ctx-sub0). Empty strings count as absent.
 */
function eventToolName(event: { toolCallName?: unknown; toolName?: unknown }): string | undefined {
  if (typeof event.toolCallName === 'string' && event.toolCallName.length > 0) {
    return event.toolCallName;
  }
  if (typeof event.toolName === 'string' && event.toolName.length > 0) {
    return event.toolName;
  }
  return undefined;
}

interface InterruptRequestedEvent {
  type: 'INTERRUPT_REQUESTED';
  reason?: string;
}

type StreamingPart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string; result?: string; error?: string; status: string; parentToolCallId?: string; agentName?: string };

export interface AgentTurnServiceDeps {
  db: DatabaseRepository;
  sessionManager: SandboxSessionManager;
  eventBus: TypedEventBus;
  /** Session-turn executor for running turns in sandbox containers. */
  sessionTurnService: SessionTurnExecutor;
  performance?: PerformanceRecorder;
  /**
   * Per-run spend caps on per-session gateway keys. Absent when the model
   * gateway (or its admin key) is off: budgets then apply at admission only.
   */
  turnSpendCaps?: Pick<SessionGatewayKeyManager, 'prepareTurn' | 'capForTurn' | 'settleTurn'>;
  /** Restores projector state before a takeover continues a turn (ADR 025). */
  turnProjection?: Pick<CanonicalLog, 'rehydrateTurnProjection'>;
}

export interface ExecuteTurnParams {
  agentDef: AgentDefinition;
  messages: Message[];
  agentId: string;
  conversationId: string;
  turnId: string;
  mode: 'interactive' | 'background';
  taskDescription: string;
  turnSecrets?: TurnSecrets;
  concurrencyReservation?: ConcurrencyReservation;
  suppressTurnStartedEvent?: boolean;
  deliveryContext?: TurnDeliveryContext;
  /** Existing ACTIVE sandbox selected before an atomic continuation claim. */
  sandboxSessionId?: string;
  /** Stable attempt namespace for idempotent HITL continuation messages. */
  continuationAttemptId?: string;
  /** Cancels delivery when its cross-replica lease is lost. */
  signal?: AbortSignal;
  /**
   * Crash takeover (ADR 025): re-attach to the delivery still running in
   * `sandboxSessionId` instead of delivering the turn. The whole journal is
   * replayed; events whose effects are already durable only rebuild local
   * state, later ones are applied (idempotently) as usual. Requires
   * `deliveryContext` (the successor's fence) and `sandboxSessionId`.
   * Throws TurnAttachUnavailableError, leaving the turn open, when the
   * sandbox cannot be re-attached.
   */
  takeover?: boolean;
}

/**
  * Extracted business logic for executing an agent session.
 *
 * Streams events from the sandbox, emits typed lifecycle events,
 * persists messages only from MESSAGE_COMMITTED events (sandbox is source of truth),
  * completes the session in the registry.
 */
export class AgentTurnService {
  private db: DatabaseRepository;
  private sessionManager: SandboxSessionManager;
  private eventBus: TypedEventBus;
  private sessionTurnService: SessionTurnExecutor;
  private turnFinalizer: TurnFinalizer;
  private performance: PerformanceRecorder;
  private turnSpendCaps: AgentTurnServiceDeps['turnSpendCaps'];
  private turnProjection: AgentTurnServiceDeps['turnProjection'];

  constructor(deps: AgentTurnServiceDeps) {
    this.turnSpendCaps = deps.turnSpendCaps;
    this.db = deps.db;
    this.sessionManager = deps.sessionManager;
    this.eventBus = deps.eventBus;
    this.sessionTurnService = deps.sessionTurnService;
    this.performance = deps.performance ?? performanceInstrumentation;
    this.turnProjection = deps.turnProjection;
    this.turnFinalizer = new TurnFinalizer({ db: deps.db, eventBus: deps.eventBus, logger: console });
  }

  /**
   * Execute an agent run: iterate over sandbox events, emit typed lifecycle events,
   * persist messages only from MESSAGE_COMMITTED events and complete the run
   * in the registry.
   *
   * The sandbox is the source of truth — no delta accumulation occurs here.
   */
  async executeTurn(params: ExecuteTurnParams): Promise<void> {
    const { agentDef, messages, agentId, conversationId, turnId, mode, taskDescription } = params;
    const harnessName = agentDef.harness ?? 'langgraph';
    const performanceAttributes = {
      'stablehand.turn.id': turnId,
      'stablehand.agent.id': agentId,
      'stablehand.conversation.id': conversationId,
      'stablehand.harness': harnessName,
      'stablehand.mode': mode,
    };
    const turnExecutionMeasurement = this.performance.start(
      'turn.execute',
      performanceAttributes,
    );
    let deliveryMeasurement: PerformanceMeasurement | undefined;
    let firstEventMeasurement: PerformanceMeasurement | undefined;
    let firstTokenMeasurement: PerformanceMeasurement | undefined;
    let deliveryStarted = false;
    let eventObserved = false;
    let tokenObserved = false;
    let deliveryContext = params.deliveryContext;
    let ownedDeliveryLease: TurnDeliveryLeaseGuard | undefined;
    let deliverySignal = params.signal;
    const isInterruptContinuation = params.continuationAttemptId !== undefined;
    const isTakeover = params.takeover === true;
    if (isTakeover && (!params.deliveryContext || !params.sandboxSessionId)) {
      throw new Error(`Turn ${turnId} takeover requires a delivery fence and its sandbox session`);
    }
    // ADR 025 replay state: events at or before the watermark already have
    // durable effects and only rebuild local state; later events are applied.
    let takeoverWatermark: { deliveryId: string; deliverySeq: number } | undefined;
    let rebuildingEvent = false;
    let currentDeliveryStamp: DeliveryStamp | undefined;
    let takeoverUnavailable: TurnAttachUnavailableError | undefined;
    let syntheticToolCallCounter = 0;

    const startedAt = Date.now();

    let sandboxSessionId: string | undefined;
    let signal: AbortSignal | undefined;
    let turnError: Error | undefined;
    let wasCancelled = false;
    let encounteredError = false;
    let lastErrorMessage = '';
    let gatewayBudgetRefusal: GatewayBudgetRefusalReport | null = null;
    let stopReason: TurnStopReason | undefined;
    let turnUsage: ApiTokenUsage | undefined;
    let releaseConcurrencyReservation = params.concurrencyReservation?.release;

    const pendingToolCalls = new Map<string, { id: string; name: string; args: string; result?: string; error?: string; status: string }>();
    let streamingParts: StreamingPart[] = [];
    let accumulatedText = '';
    let sawToolActivity = false;
    let sawCommittedMessage = false;
    let sawInterruptRequest = false;
    let sawRunResult = false;
    let assistantFlushedForBatch = false;
    let flushedAssistantMessageId: string | null = null;
    let flushedAssistantMessageSeq: number | null = null;
    let flushedAssistantProjectionDirty = false;
    let streamedMessageCounter = 0;
    let currentStreamedMessageId: string | undefined;
    let canonicalMessageCounter = 0;
    const pendingCanonicalMessages = new Map<string, MessageSelect>();
    let lastCanonicalPublishError: Error | undefined;
    let continuationExecutionError: Error | undefined;

    const deliveryPersistenceContext = (): EventPersistenceContext | undefined =>
      deliveryContext
        ? {
          deliveryFence: {
            ...deliveryContext.fence,
          },
        }
        : undefined;

    const expectedDeliveryFence = () =>
      deliveryContext
        ? {
          ...deliveryContext.fence,
        }
        : undefined;

    const emitTurnEvent = <K extends EventName>(
      event: K,
      payload: EventMap[K],
    ): void => {
      if (rebuildingEvent) {
        return;
      }
      const stampedPayload = currentDeliveryStamp
        ? { ...payload, delivery: currentDeliveryStamp }
        : payload;
      const persistenceContext = deliveryPersistenceContext();
      if (persistenceContext) {
        this.eventBus.emit(event, stampedPayload, persistenceContext);
      } else {
        this.eventBus.emit(event, stampedPayload);
      }
    };

    const normalizeContent = (value: unknown): string => {
      if (typeof value === 'string') return sanitizeDbText(value, 'normalizeContent');
      if (value == null) return '';

      try {
        return sanitizeDbText(JSON.stringify(value), 'normalizeContent');
      } catch {
        return sanitizeDbText(String(value), 'normalizeContent');
      }
    };

    const buildPersistedToolCalls = () => Array.from(pendingToolCalls.values()).map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      status: tc.status,
      ...(tc.error ? { error: tc.error } : {}),
    }));

    const buildCommittedParts = (committed: MessageCommittedEvent): StreamingPart[] => {
      if (streamingParts.length > 0) {
        return [...streamingParts];
      }

      const fallbackParts: StreamingPart[] = [];
      if (committed.content) {
        fallbackParts.push({
          type: 'text',
          content: committed.content,
        });
      }

      if (Array.isArray(committed.toolCalls)) {
        fallbackParts.push(...committed.toolCalls.map((toolCall) => ({
          type: 'tool_call' as const,
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          status: toolCall.status,
        })));
      }

      return fallbackParts;
    };

    const releaseReservedConcurrency = (): void => {
      if (!releaseConcurrencyReservation) {
        return;
      }

      releaseConcurrencyReservation();
      releaseConcurrencyReservation = undefined;
    };

    const drainPendingCanonicalMessages = async (): Promise<boolean> => {
      const pending = Array.from(pendingCanonicalMessages.values()).sort((left, right) =>
        (left.messageSeq ?? Number.MAX_SAFE_INTEGER) - (right.messageSeq ?? Number.MAX_SAFE_INTEGER)
        || left.messageRevision - right.messageRevision,
      );
      for (const stored of pending) {
        try {
          await assertDeliveryOwnership();
          const current = await this.db.getMessage(stored.id) ?? stored;
          if (current.publishedRevision >= current.messageRevision) {
            pendingCanonicalMessages.delete(current.id);
            continue;
          }
          await publishMessageCanonicalState(
            { eventBus: this.eventBus },
            current,
            deliveryPersistenceContext(),
          );
          await assertDeliveryOwnership();
          pendingCanonicalMessages.delete(current.id);
          lastCanonicalPublishError = undefined;
        } catch (err) {
          lastCanonicalPublishError = err instanceof Error ? err : new Error(String(err));
          console.error(
            `[AgentTurnService] Canonical message publication is pending for turn ${turnId}:`,
            lastCanonicalPublishError,
          );
          return false;
        }
      }
      return true;
    };

    const stageCanonicalPublish = async (message: MessageSelect): Promise<void> => {
      await assertDeliveryOwnership();
      pendingCanonicalMessages.set(message.id, message);
      await drainPendingCanonicalMessages();
      await assertDeliveryOwnership();
    };

    const updateFlushedAssistantToolState = async () => {
      if (
        !flushedAssistantMessageId
        || flushedAssistantMessageSeq === null
        || !flushedAssistantProjectionDirty
      ) return;
      if (rebuildingEvent) {
        // Already durable: a later live event re-stages the full projection.
        flushedAssistantProjectionDirty = false;
        return;
      }
      const toolCalls = buildPersistedToolCalls();
      const parts = [...streamingParts];
      await assertDeliveryOwnership();
      const updated = await this.db.stageAssistantMessageUpdate(
        flushedAssistantMessageId,
        toolCalls,
        parts,
        expectedDeliveryFence(),
      );
      if (!updated) {
        throw new Error(`Assistant message ${flushedAssistantMessageId} disappeared during projection update`);
      }
      await assertDeliveryOwnership();
      await stageCanonicalPublish(updated);
      flushedAssistantProjectionDirty = false;
    };

    const ensureTurnMessagesDurablyPublished = async (): Promise<boolean> => {
      // Retry locally known rows first, then merge the authoritative DB scan.
      // The second scan proves no repair path or partial publish left a row
      // behind before terminal state can be written.
      await drainPendingCanonicalMessages();
      try {
        const durablePending = await this.db.getMessagesPendingCanonicalPublish();
        for (const message of durablePending) {
          if (message.turnId === turnId) {
            pendingCanonicalMessages.set(message.id, message);
          }
        }
        await drainPendingCanonicalMessages();
        const remaining = (await this.db.getMessagesPendingCanonicalPublish())
          .filter((message) => message.turnId === turnId);
        for (const message of remaining) {
          pendingCanonicalMessages.set(message.id, message);
        }
        return pendingCanonicalMessages.size === 0 && remaining.length === 0;
      } catch (err) {
        lastCanonicalPublishError = err instanceof Error ? err : new Error(String(err));
        console.error(
          `[AgentTurnService] Failed to verify canonical message publication for turn ${turnId}:`,
          lastCanonicalPublishError,
        );
        return false;
      }
    };

    const commitMessage = async (
      role: MessageCommittedEvent['role'],
      content: string,
      options?: { toolCalls?: ReturnType<typeof buildPersistedToolCalls>; toolCallId?: string; parts?: StreamingPart[] },
    ) => {
      const messageNamespace = params.continuationAttemptId
        ? `${turnId}-resume-${params.continuationAttemptId}`
        : turnId;
      const messageId = `canonical-${messageNamespace}-${canonicalMessageCounter++}`;
      if (rebuildingEvent) {
        const existing = await this.db.getMessage(messageId);
        if (existing) {
          return existing;
        }
      }
      await assertDeliveryOwnership();
      const message = await this.db.addCanonicalMessage({
        id: messageId,
        agentId,
        conversationId,
        turnId,
        role,
        content,
        parts: options?.parts,
        toolCalls: options?.toolCalls,
        toolCallId: options?.toolCallId,
      }, expectedDeliveryFence());
      if (!message) {
        throw new Error(`Turn ${turnId} lost delivery ownership before message persistence`);
      }
      await assertDeliveryOwnership();
      await stageCanonicalPublish(message);
      return message;
    };

    const resolveCurrentSandboxSessionId = async (): Promise<string | undefined> => {
      if (!sandboxSessionId) return undefined;
      if (typeof this.db.getTurn !== 'function') return sandboxSessionId;
      try {
        const latestTurn = await this.db.getTurn(turnId);
        if (latestTurn?.sandboxSessionId) {
          sandboxSessionId = latestTurn.sandboxSessionId;
        }
      } catch (err) {
        console.warn(`[AgentTurnService] Failed to refresh current sandbox session for turn ${turnId}:`, err);
      }
      return sandboxSessionId;
    };

    const isDurablyCancelled = async (): Promise<boolean> => {
      if (typeof this.db.getTurn !== 'function') return false;
      try {
        const latestTurn = await this.db.getTurn(turnId);
        return latestTurn?.completedAt != null && isTurnCancelled(latestTurn.error);
      } catch (err) {
        console.warn(`[AgentTurnService] Failed to check cancellation state for turn ${turnId}:`, err);
        return false;
      }
    };

    const finalizeTurn = async (status: 'completed' | 'error' | 'cancelled', error?: string) => {
      const currentSandboxSessionId = await resolveCurrentSandboxSessionId();
      const pendingSessionReset = this.sessionManager.getPendingSessionReset(turnId);
      return this.turnFinalizer.finalize({
        turnId,
        agentId,
        conversationId,
        status,
        error,
        ...(status === 'error' && stopReason ? { stopReason } : {}),
        ...(currentSandboxSessionId ? { sandboxSessionId: currentSandboxSessionId } : {}),
        // ctx-iqzy T3: execution duration. The in-memory execute-start
        // coincides with the persisted startedAt restamped at activation, so
        // the live path agrees with the crash-rebuild/reconciler paths.
        durationMs: Date.now() - startedAt,
        ...(turnUsage ? { usage: turnUsage } : {}),
        ...(deliveryContext
          ? { expectedDeliveryFence: deliveryContext.fence }
          : {}),
        ...(pendingSessionReset
          ? { lifecycleReset: pendingSessionReset }
          : {}),
        ...(currentSandboxSessionId
          ? {
            settleSessionLifecycle: (completedAt: number) =>
              this.sessionManager.completeTurn(
                currentSandboxSessionId,
                turnId,
                agentId,
                conversationId,
                status,
                completedAt - startedAt,
                error,
                turnUsage,
              ),
          }
          : {}),
      });
    };

    const flushUncommittedMessages = async () => {
      if (pendingToolCalls.size > 0 && !assistantFlushedForBatch) {
        const parts = [...streamingParts];
        const toolCalls = buildPersistedToolCalls();
        const message = await commitMessage('assistant', accumulatedText, {
          parts,
          toolCalls,
        });
        flushedAssistantMessageId = message.id;
        flushedAssistantMessageSeq = message.messageSeq;
        accumulatedText = '';
        assistantFlushedForBatch = true;
      } else if (pendingToolCalls.size > 0 && assistantFlushedForBatch && flushedAssistantMessageId) {
        await updateFlushedAssistantToolState();
        accumulatedText = '';
      } else if (accumulatedText) {
        const parts = [...streamingParts];
        await commitMessage('assistant', accumulatedText, {
          parts,
        });
        accumulatedText = '';
      }
    };

    const hasRunningToolCalls = () =>
      Array.from(pendingToolCalls.values()).some((toolCall) =>
        toolCall.status === 'running' || toolCall.status === 'pending',
      )
      || streamingParts.some((part) =>
        part.type === 'tool_call' && (part.status === 'running' || part.status === 'pending'),
      );

    const hasCurrentDeliveryFence = async (): Promise<boolean> => {
      if (!deliveryContext) {
        return true;
      }
      return this.db.isTurnDeliveryFenceCurrent(
        turnId,
        deliveryContext.fence,
      );
    };

    const assertDeliveryOwnership = async (): Promise<void> => {
      if (!deliveryContext) {
        return;
      }
      deliverySignal?.throwIfAborted();
      if (!await hasCurrentDeliveryFence()) {
        throw new Error(`Turn ${turnId} lost delivery ownership`);
      }
      deliverySignal?.throwIfAborted();
    };

    const settleStaleDeliveryRuntime = async (): Promise<void> => {
      if (!sandboxSessionId) {
        return;
      }
      await this.sessionManager.abandonTurnDelivery(
        sandboxSessionId,
        turnId,
      );
    };

    const settleExecution = async (): Promise<void> => {
      const activeDeliveryContext = deliveryContext;
      if (!activeDeliveryContext) {
        return;
      }
      if (!await hasCurrentDeliveryFence()) {
        await settleStaleDeliveryRuntime();
        return;
      }
      if (!wasCancelled && !turnError && hasRunningToolCalls()) {
        turnError = new Error(TURN_ERROR_RUNNING_TOOL_CALLS_AT_END);
      }

      // ctx-w03u: a "successful" turn that provably produced nothing — no
      // text, no committed message, no tool or interrupt activity, and no
      // usage — must not be recorded as completed. The sandbox has already
      // spent its one in-place retry by the time this stream ends.
      const reportedUsage = turnUsage
        ? turnUsage.inputTokens + turnUsage.outputTokens + turnUsage.totalTokens
        : 0;
      if (
        !wasCancelled
        && !turnError
        && !isInterruptContinuation
        && !tokenObserved
        && accumulatedText.length === 0
        && !flushedAssistantMessageId
        && !sawCommittedMessage
        && !sawToolActivity
        && !sawInterruptRequest
        && !sawRunResult
        && pendingToolCalls.size === 0
        && reportedUsage === 0
      ) {
        turnError = new Error(TURN_ERROR_EMPTY_MODEL_OUTPUT);
      }

      const status: 'completed' | 'error' | 'cancelled' =
        wasCancelled
          ? 'cancelled'
          : turnError
            ? 'error'
            : 'completed';

      // A non-completed turn must not persist 'running' tool calls (ctx-nm3o):
      // close them out in both projections before the flush below writes them.
      if (status !== 'completed') {
        for (const toolCall of pendingToolCalls.values()) {
          if (toolCall.status === 'running') {
            toolCall.status = 'error';
            toolCall.error = TOOL_CALL_INTERRUPTED_ERROR;
            flushedAssistantProjectionDirty = true;
          }
        }
        for (const part of streamingParts) {
          if (part.type === 'tool_call' && part.status === 'running') {
            part.status = 'error';
            part.error = TOOL_CALL_INTERRUPTED_ERROR;
            flushedAssistantProjectionDirty = true;
          }
        }
      }

      let flushError: Error | undefined;
      try {
        if (!await hasCurrentDeliveryFence()) {
          await settleStaleDeliveryRuntime();
          return;
        }
        await flushUncommittedMessages();
      } catch (err) {
        flushError = err instanceof Error ? err : new Error(String(err));
        console.error(
          `[AgentTurnService] Failed to flush uncommitted messages for turn ${turnId}:`,
          flushError,
        );
      }

      const finalError = turnError && flushError
        ? `${turnError.message}; additionally flush failed: ${flushError.message}`
        : turnError?.message ?? flushError?.message;
      const finalStatus = finalError
        ? (status === 'completed' ? 'error' : status)
        : status;

      if (finalStatus !== 'completed') {
        if (!await hasCurrentDeliveryFence()) {
          await settleStaleDeliveryRuntime();
          return;
        }
        try {
          await repairConversationRunningToolCalls({
            db: this.db,
            eventBus: this.eventBus,
            logger: console,
          }, conversationId, {
            turnId,
            deliveryFence: activeDeliveryContext.fence,
            signal: deliverySignal,
          });
          await assertDeliveryOwnership();
        } catch (repairErr) {
          console.error(
            `[AgentTurnService] Failed to repair running tool calls for conversation ${conversationId}:`,
            repairErr,
          );
        }
      }

      if (!await hasCurrentDeliveryFence()) {
        await settleStaleDeliveryRuntime();
        return;
      }
      const messagesDurablyPublished = await ensureTurnMessagesDurablyPublished();
      if (!messagesDurablyPublished) {
        // A terminal frame must never overtake a message row whose committed
        // or updated frame is still absent. Leave the turn open; startup
        // recovery publishes rows before stranded-turn reconciliation.
        console.error(
          `[AgentTurnService] Leaving turn ${turnId} open because canonical message publication is still pending:`,
          lastCanonicalPublishError,
        );
        if (isInterruptContinuation) {
          continuationExecutionError = new Error(
            `Interrupt continuation ${params.continuationAttemptId} left canonical message publication pending`,
            lastCanonicalPublishError
              ? { cause: lastCanonicalPublishError }
              : undefined,
          );
          await settleStaleDeliveryRuntime();
        }
        return;
      }

      if (isInterruptContinuation && finalStatus !== 'completed') {
        // A failed continuation stays retryable: only a successful continuation
        // may terminalize the original HITL turn.
        continuationExecutionError = new Error(
          finalError
            ?? `Interrupt continuation ${params.continuationAttemptId} failed`,
        );
        if (sandboxSessionId) {
          await this.sessionManager.abandonTurnDelivery(
            sandboxSessionId,
            turnId,
          );
        }
        return;
      }

      try {
        if (!await hasCurrentDeliveryFence()) {
          await settleStaleDeliveryRuntime();
          return;
        }
        const finalization = await finalizeTurn(finalStatus, finalError);
        // A terminal run no longer needs its cap; a paused (HITL) run keeps
        // it so its continuation resumes under the same budget.
        this.turnSpendCaps?.settleTurn(turnId);
        if (
          finalization.finalized
          && finalStatus === 'error'
          && stopReason?.code === BUDGET_REACHED_CODE
        ) {
          // A system event about a finished turn (like budget.threshold), so
          // it is not delivery-fenced: the fence closes with the turn.
          this.eventBus.emit('budget.reached', {
            turnId,
            agentId,
            conversationId,
            ...(sandboxSessionId ? { sandboxSessionId } : {}),
            source: stopReason.source,
            capUsd: stopReason.capUsd,
            spentUsd: stopReason.spentUsd,
            ...(stopReason.policyId ? { policyId: stopReason.policyId } : {}),
            ...(stopReason.policyName ? { policyName: stopReason.policyName } : {}),
            ...(stopReason.bucket ? { bucket: stopReason.bucket } : {}),
            timestamp: Date.now(),
          });
        }
        if (isInterruptContinuation && !finalization.finalized) {
          continuationExecutionError = new Error(
            `Interrupt continuation ${params.continuationAttemptId} lost delivery ownership during finalization`,
          );
          await settleStaleDeliveryRuntime();
        }
      } catch (finalizeErr) {
        // TurnFinalizer is the single terminal writer (ADR-014) — no direct
        // fallback write here. Startup recovery closes still-open turns and
        // republishes finalized rows whose terminal frame batch is pending.
        console.error(
          `[AgentTurnService] finalizeTurn failed for turn ${turnId}:`,
          finalizeErr,
        );
        if (isInterruptContinuation) {
          continuationExecutionError = finalizeErr instanceof Error
            ? finalizeErr
            : new Error(String(finalizeErr));
          await settleStaleDeliveryRuntime();
        }
      }
    };

    try {
      if (!deliveryContext) {
        ownedDeliveryLease = await acquireTurnDeliveryLease(
          { db: this.db, logger: console },
          turnId,
        );
        if (!ownedDeliveryLease) {
          releaseReservedConcurrency();
          return;
        }
        deliveryContext = { fence: ownedDeliveryLease.fence };
        deliverySignal = params.signal
          ? AbortSignal.any([params.signal, ownedDeliveryLease.signal])
          : ownedDeliveryLease.signal;
      }

      deliverySignal?.throwIfAborted();
      if (await isDurablyCancelled()) {
        wasCancelled = true;
        turnError = new Error(TURN_CANCELLED_MESSAGE);
        return;
      }

      const sandboxSession: SessionRecord = params.sandboxSessionId
        ? this.sessionManager.findSessionById(params.sandboxSessionId)
          ?? (() => {
            throw new Error(
              `Prepared interrupt continuation session ${params.sandboxSessionId} is not active`,
            );
          })()
        : await this.performance.measure(
          'session.ensure',
          performanceAttributes,
          () => this.sessionManager.ensureSession(
            conversationId,
            agentDef,
            agentId,
            params.concurrencyReservation
              ? { concurrencyReservationId: params.concurrencyReservation.id }
              : undefined,
          ),
        );
      if (params.sandboxSessionId && (
        sandboxSession.status !== 'ACTIVE'
        || sandboxSession.conversationId !== conversationId
        || sandboxSession.agentId !== agentId
      )) {
        throw new Error(
          `Sandbox session ${sandboxSession.sessionId} does not match turn ${turnId} `
          + `(status=${sandboxSession.status}, conversation=${sandboxSession.conversationId}, `
          + `agent=${sandboxSession.agentId})`,
        );
      }
      sandboxSessionId = sandboxSession.sessionId;
      releaseReservedConcurrency();

      // Arm this run's spend cap on the session's gateway key, so the
      // gateway itself stops the run mid-flight when the cap is reached.
      await this.turnSpendCaps?.prepareTurn({
        sessionId: sandboxSessionId,
        turnId,
        harnessConfig: agentDef.harnessConfig,
        continuation: isInterruptContinuation,
      });

      deliverySignal?.throwIfAborted();
      if (await isDurablyCancelled()) {
        wasCancelled = true;
        turnError = new Error(TURN_CANCELLED_MESSAGE);
        return;
      }

      const turnSignal = this.sessionManager.startTurn(
        sandboxSessionId,
        turnId,
        agentId,
        conversationId,
        mode,
        taskDescription,
        deliveryContext
          ? {
              suppressEvent: true,
              deliveryContext: deliveryContext,
              ...(isInterruptContinuation || isTakeover
                ? { deliveryAdmission: 'continuation' as const }
                : {}),
            }
          : params.suppressTurnStartedEvent
            ? { suppressEvent: true }
            : undefined,
      );
      const activeSignals = [turnSignal, deliverySignal]
        .filter((candidate): candidate is AbortSignal => candidate !== undefined);
      signal = activeSignals.length > 1
        ? AbortSignal.any(activeSignals)
        : activeSignals[0];

      const deliveryAttributes = {
        ...performanceAttributes,
        'stablehand.session.id': sandboxSessionId,
      };
      deliveryMeasurement = this.performance.start(
        'turn.delivery',
        deliveryAttributes,
      );
      firstEventMeasurement = this.performance.start(
        'turn.first_event',
        deliveryAttributes,
      );
      firstTokenMeasurement = this.performance.start(
        'turn.first_token',
        deliveryAttributes,
      );
      deliveryStarted = true;

      if (isTakeover) {
        takeoverWatermark = await this.db.getTurnDeliveryWatermark(turnId);
        await this.turnProjection?.rehydrateTurnProjection(turnId);
        console.log(
          `[AgentTurnService] taking over turn ${turnId} on session ${sandboxSessionId}; `
          + (takeoverWatermark
            ? `effects durable through delivery ${takeoverWatermark.deliveryId} seq ${takeoverWatermark.deliverySeq}`
            : 'no journaled effects are durable yet'),
        );
      }

      const eventSource: AsyncGenerator<AgentSessionEvent> = this.sessionTurnService.executeSessionTurn(
        agentDef,
        conversationId,
        messages,
        turnId,
        {
          signal,
          agentId,
          existingSessionId: sandboxSessionId,
          ...(params.turnSecrets ? { turnSecrets: params.turnSecrets } : {}),
          ...(isTakeover ? { attach: { afterDeliverySeq: 0 } } : {}),
        },
      );

      for await (const event of eventSource) {
        eventObserved = true;
        firstEventMeasurement.end('ok');
        if (signal?.aborted) break;
        currentDeliveryStamp = readDeliveryStamp(event);
        rebuildingEvent = Boolean(
          isTakeover
          && currentDeliveryStamp
          && takeoverWatermark
          && currentDeliveryStamp.id === takeoverWatermark.deliveryId
          && currentDeliveryStamp.seq <= takeoverWatermark.deliverySeq,
        );
        if (!rebuildingEvent) {
          await assertDeliveryOwnership();
        }

        if (!INDIVIDUALLY_HANDLED.has(event.type)) {
          emitTurnEvent('ag_ui.event', {
            turnId,
            agentId,
            conversationId,
            event: event as Record<string, unknown>,
            timestamp: Date.now(),
          });
        }

        if (event.type === 'RUN_ERROR') {
          encounteredError = true;
          // Capture the actual error message from the event for descriptive error reporting
          if ('error' in event && typeof event.error === 'string' && event.error.length > 0) {
            lastErrorMessage = event.error;
          }
          gatewayBudgetRefusal = readGatewayBudgetRefusal(event) ?? gatewayBudgetRefusal;
        }

        if (event.type === 'RUN_FINISHED') {
          if ('result' in event && typeof event.result === 'string' && event.result.length > 0) {
            sawRunResult = true;
          }
          const usage = event.usage;
          if (usage && typeof usage === 'object') {
            const u = usage as Record<string, unknown>;
            turnUsage = {
              inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : 0,
              outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
              totalTokens: typeof u.totalTokens === 'number' ? u.totalTokens : 0,
              ...(typeof u.costUsd === 'number' ? { costUsd: u.costUsd } : {}),
            };
          }
        }

        if (event.type === 'TOOL_CALL_START') {
          sawToolActivity = true;
          currentStreamedMessageId = undefined;
          const e = event as Record<string, unknown>;
          // Deterministic fallback id: a takeover replay must rebuild the
          // same projection the original owner persisted (ADR 025).
          const tcId = (e.toolCallId as string) || `tc-${turnId}-${++syntheticToolCallCounter}`;
          const toolArgs = typeof e.args === 'string'
            ? e.args
            : e.args === undefined
              ? ''
              : JSON.stringify(e.args);
          // Subagent annotation (ctx-5myn): calls spawned by a Task tool ride
          // flat with a parent pointer; the UI computes nesting.
          const parentToolCallId = typeof e.parentToolCallId === 'string' ? e.parentToolCallId : undefined;
          const subagentName = typeof e.agentName === 'string' ? e.agentName : undefined;
          const startedToolName = eventToolName(e) ?? 'unknown';
          pendingToolCalls.set(tcId, {
            id: tcId,
            name: startedToolName,
            args: toolArgs,
            status: 'running',
          });
          streamingParts.push({
            type: 'tool_call',
            id: tcId,
            name: startedToolName,
            args: toolArgs,
            status: 'running',
            ...(parentToolCallId ? { parentToolCallId } : {}),
            ...(subagentName ? { agentName: subagentName } : {}),
          });
          if (assistantFlushedForBatch) {
            flushedAssistantProjectionDirty = true;
          }
        }

        if (event.type === 'TOOL_CALL_ARGS') {
          const e = event as Record<string, unknown>;
          const tc = pendingToolCalls.get(e.toolCallId as string);
          const toolArgsDelta = (e.args as string) || (e.delta as string) || '';
          if (tc) {
            tc.args += toolArgsDelta;
          }
          const part = streamingParts.find((streamingPart) => streamingPart.type === 'tool_call' && streamingPart.id === (e.toolCallId as string));
          if (part && part.type === 'tool_call') {
            part.args += toolArgsDelta;
          }
          if (assistantFlushedForBatch && (tc || part)) {
            flushedAssistantProjectionDirty = true;
          }
        }

        if (event.type === 'TOOL_CALL_END') {
          const e = event as Record<string, unknown>;
          const tc = pendingToolCalls.get(e.toolCallId as string);
          if (tc) tc.status = 'complete';
          const part = streamingParts.find((streamingPart) => streamingPart.type === 'tool_call' && streamingPart.id === (e.toolCallId as string));
          if (part && part.type === 'tool_call') part.status = 'complete';
          if (assistantFlushedForBatch && (tc || part)) {
            flushedAssistantProjectionDirty = true;
          }
        }

        if (event.type === 'TOOL_CALL_RESULT') {
          const e = event as Record<string, unknown>;
          const tcId = e.toolCallId as string;
          const tc = pendingToolCalls.get(tcId);
          const part = streamingParts.find((streamingPart) => streamingPart.type === 'tool_call' && streamingPart.id === tcId);
          if (tc) {
            tc.result = normalizeContent(e.result);
            tc.error = e.error as string | undefined;
            tc.status = tc.error ? 'error' : 'complete';
          }
          if (part && part.type === 'tool_call') {
            part.result = normalizeContent(e.result);
            part.error = e.error as string | undefined;
            part.status = part.error ? 'error' : 'complete';
          }
          if (assistantFlushedForBatch && (tc || part)) {
            flushedAssistantProjectionDirty = true;
          }

          if (!assistantFlushedForBatch && pendingToolCalls.size > 0) {
            const parts = [...streamingParts];
            const toolCalls = buildPersistedToolCalls();
            const flushedAssistantContent = accumulatedText;
            const message = await commitMessage('assistant', flushedAssistantContent, {
              parts,
              toolCalls,
            });
            flushedAssistantMessageId = message.id;
            flushedAssistantMessageSeq = message.messageSeq;
            flushedAssistantProjectionDirty = false;
            accumulatedText = '';
            assistantFlushedForBatch = true;
          } else if (assistantFlushedForBatch && flushedAssistantMessageId) {
            await updateFlushedAssistantToolState();
            // Text between tool calls is now recorded on the flushed message's
            // parts; only text after the LAST tool result may reach the final
            // message (ctx-hb4b).
            accumulatedText = '';
          }

          await commitMessage('tool', normalizeContent(e.result), {
            toolCallId: tcId,
          });
        }

        if (event.type === 'MESSAGE_COMMITTED') {
          const committed = event as unknown as MessageCommittedEvent;
          if (committed.role !== 'assistant' && committed.role !== 'tool') {
            // ctx-w03u: never coerce unknown-role output into an assistant
            // message. Preserve the original payload in telemetry and close
            // the turn as an error instead of persisting a guessed role.
            console.error(
              `[AgentTurnService] Turn ${turnId} received MESSAGE_COMMITTED with unknown role; original payload preserved:`,
              JSON.stringify(committed),
            );
            turnError = new Error(
              `Harness committed a message with unknown role '${String(committed.role)}'; refusing to persist it as assistant output`,
            );
            continue;
          }
          sawCommittedMessage = true;
          if (assistantFlushedForBatch) {
            // The tool-carrying assistant message was already persisted at the
            // first tool result; the final message owns only content produced
            // after that flush so a tool_call part is never persisted twice
            // (ctx-hb4b). With no trailing text there is nothing new to say.
            const trailingParts: StreamingPart[] = accumulatedText
              ? [{ type: 'text', content: accumulatedText }]
              : [];
            if (accumulatedText) {
              const message = await commitMessage(committed.role, accumulatedText, {
                parts: trailingParts,
              });
              flushedAssistantMessageId = message.id;
              flushedAssistantMessageSeq = message.messageSeq;
            }
            assistantFlushedForBatch = false;
            flushedAssistantProjectionDirty = false;
            pendingToolCalls.clear();
            accumulatedText = '';
          } else {
            const finalParts = buildCommittedParts(committed);
            const message = await commitMessage(committed.role, committed.content, {
              parts: finalParts,
              toolCalls: committed.toolCalls as ReturnType<typeof buildPersistedToolCalls> | undefined,
              toolCallId: committed.toolCallId,
            });
            flushedAssistantMessageId = message.id;
            flushedAssistantMessageSeq = message.messageSeq;
            accumulatedText = '';
          }

          streamingParts = [];
        }

        // Emit text chunks to internal event bus (for triggers and monitoring)
        if (event.type === 'TEXT_MESSAGE_CONTENT' && 'delta' in event) {
          const textEvent = event as unknown as TextContentEvent;
          if (textEvent.delta.length > 0) {
            tokenObserved = true;
            firstTokenMeasurement.end('ok');
          }
          accumulatedText += textEvent.delta;

          const lastPart = streamingParts[streamingParts.length - 1];
          if (lastPart?.type === 'text') {
            lastPart.content += textEvent.delta;
          } else {
            streamingParts.push({
              type: 'text',
              content: textEvent.delta,
            });
          }
          if (assistantFlushedForBatch) {
            flushedAssistantProjectionDirty = true;
          }

          if (textEvent.messageId) {
            currentStreamedMessageId = textEvent.messageId;
          } else if (!currentStreamedMessageId) {
            streamedMessageCounter += 1;
            currentStreamedMessageId = `${turnId}-m${streamedMessageCounter}`;
          }
          emitTurnEvent('message.delta', {
            turnId,
            agentId,
            conversationId,
            messageId: currentStreamedMessageId,
            delta: textEvent.delta,
            timestamp: Date.now(),
          });
        }

        const toolStartName = event.type === 'TOOL_CALL_START'
          ? eventToolName(event as unknown as ToolCallStartEvent)
          : undefined;
        if (toolStartName !== undefined) {
          const toolStart = event as unknown as ToolCallStartEvent;
          const rawStart = event as Record<string, unknown>;
          emitTurnEvent('tool_call.started', {
            turnId,
            agentId,
            conversationId,
            toolCallId: toolStart.toolCallId ?? '',
            toolName: toolStartName,
            args: toolStart.args ?? {},
            ...(typeof rawStart.parentToolCallId === 'string'
              ? { parentToolCallId: rawStart.parentToolCallId }
              : {}),
            ...(typeof rawStart.agentName === 'string'
              ? { agentName: rawStart.agentName }
              : {}),
            timestamp: Date.now(),
          } as unknown as EventMap['tool_call.started']);
        }
        if (event.type === 'TOOL_CALL_RESULT' && 'result' in event) {
          sawToolActivity = true;
          const toolResult = event as unknown as ToolCallResultEvent;
          const toolCallId = toolResult.toolCallId ?? '';
          const knownToolName = toolCallId ? pendingToolCalls.get(toolCallId)?.name : undefined;
          const toolName = eventToolName(toolResult) ?? knownToolName ?? '';
          emitTurnEvent('tool_call.completed', {
            turnId,
            agentId,
            conversationId,
            toolCallId,
            toolName,
            result: toolResultForEvent(toolName, toolResult.result),
            durationMs: toolResult.durationMs ?? 0,
            timestamp: Date.now(),
          } as unknown as EventMap['tool_call.completed']);
        }

        if (event.type === 'INTERRUPT_REQUESTED') {
          sawInterruptRequest = true;
          void (event as unknown as InterruptRequestedEvent);
        }
      }

      if (signal?.aborted) {
        wasCancelled = true;
        turnError = new Error('Turn cancelled');
      } else if (encounteredError && gatewayBudgetRefusal) {
        // The gateway refused a call because the run's budget ran out: a
        // typed, distinct outcome with the spent-vs-cap numbers.
        stopReason = budgetStopReason(this.turnSpendCaps?.capForTurn(turnId), gatewayBudgetRefusal);
        turnError = new Error(turnStopReasonMessage(stopReason));
      } else if (encounteredError) {
        turnError = new Error(lastErrorMessage || 'Turn completed with errors (no detail captured)');
      }
    } catch (err) {
      if (err instanceof TurnAttachUnavailableError) {
        takeoverUnavailable = err;
      }
      turnError = err instanceof Error ? err : new Error(String(err));
      if (isTurnCancelled(turnError.message)) {
        wasCancelled = true;
      }
      const lostDeliveryOwnership = deliveryContext
        && (
          deliverySignal?.aborted
          || turnError.message.includes('lost delivery ownership')
        );
      if (!wasCancelled && !lostDeliveryOwnership) {
        console.error(`[AgentTurnService] Turn ${turnId} error:`, turnError.stack ?? turnError.message);
      }
    } finally {
      rebuildingEvent = false;
      currentDeliveryStamp = undefined;
      releaseReservedConcurrency();
      try {
        if (takeoverUnavailable) {
          // Leave the turn open: the takeover caller owns the fallback.
          await settleStaleDeliveryRuntime();
        } else {
          await settleExecution();
        }
      } finally {
        try {
          await ownedDeliveryLease?.release();
        } finally {
          const outcome: PerformanceOutcome = wasCancelled
            ? 'cancelled'
            : turnError
              ? 'error'
              : deliveryStarted
                ? 'ok'
                : 'empty';
          const error = outcome === 'error' ? turnError : undefined;
          if (!eventObserved) {
            firstEventMeasurement?.end(
              outcome === 'ok' ? 'empty' : outcome,
              error,
            );
          }
          if (!tokenObserved) {
            firstTokenMeasurement?.end(
              outcome === 'ok' ? 'empty' : outcome,
              error,
            );
          }
          deliveryMeasurement?.end(outcome, error);
          turnExecutionMeasurement.end(outcome, error);
        }
      }
    }
    if (continuationExecutionError) {
      throw continuationExecutionError;
    }
    if (takeoverUnavailable) {
      throw takeoverUnavailable;
    }
  }
}
