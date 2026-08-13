import { randomUUID } from 'node:crypto';

import type { TypedEventBus } from '../events/bus.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { AgentDefinition } from '@ctxmill/sandbox-daemon';
import { buildAgentDefinition, type StoredAgent } from './agent-definition.js';
import type { AgentTurnService } from './agent-turn-service.js';
import { mapMessagesToInternal } from './routes/agent-helpers.js';
import { ConcurrencyLimitError } from './session-manager/concurrency-limit-error.js';
import type { ConcurrencyReservation } from './session-manager/session-turn-orchestrator.js';
import type { TurnSecrets } from './session-manager/turn-secrets.js';
import { TurnFinalizer } from './turn-finalizer.js';
import type { BudgetEnforcer } from './budget-enforcer.js';
import type { TurnQueueAdmission } from './turn-queue-admission.js';
import { TagConflictError, readBudgetDimensions, readDefaultTags } from './budgets.js';
import type { TurnDeliveryContext } from './turn-delivery-fence.js';
import { acquireTurnDeliveryLease } from './turn-delivery-lease.js';
import type { TurnSecretEnvelopeCodec } from './turn-secret-envelope.js';
import {
  resolveModelGatewayTurnAttribution,
} from '../cost-control/model-gateway-attribution.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface TurnStartupServiceDeps {
  allocateTurnId?: () => string;
  logger: Logger;
  modelGateway?:
    | { enabled: false }
    | { enabled: true; profile: 'default'; revision: string };
  turnSecretEnvelopeCodec: Pick<
    TurnSecretEnvelopeCodec,
    'open' | 'seal'
  >;
}

type TurnMode = 'interactive' | 'background';

export class AgentModeNotAllowedError extends Error {
  readonly code = 'agent_mode_not_allowed';
  readonly statusCode = 409;

  constructor(
    readonly configuredMode: Exclude<AgentDefinition['mode'], undefined>,
    readonly requestedMode: TurnMode,
  ) {
    super(`Agent mode "${configuredMode}" does not allow ${requestedMode} turns`);
    this.name = 'AgentModeNotAllowedError';
  }
}

type ExecutionDeps = {
  db: Pick<
    DatabaseRepository,
    'addMessage' | 'claimTurnDeliveryLease' | 'createConversation' | 'createTurnWithSecretEnvelope' | 'deleteMessage' | 'finalizeTurnIfOpen' | 'finalizeTurnAndMarkLifecycleDraining' | 'getAgent' | 'getConversation' | 'getMessages' | 'getTurn' | 'getTurnSecretEnvelope' | 'releaseTurnDeliveryLease' | 'renewTurnDeliveryLease'
  >;
  eventBus?: Pick<TypedEventBus, 'emit'> & Partial<Pick<TypedEventBus, 'emitAsync'>>;
  sessionManager?: {
    checkConcurrencyLimit(agentId: string): void;
    reserveConcurrencySlot?(agentId: string): ConcurrencyReservation;
  } | null;
  agentTurnService: Pick<AgentTurnService, 'executeTurn'>;
  budgetEnforcer?: Pick<BudgetEnforcer, 'checkAdmission'> | null;
  queueAdmission?: TurnQueueAdmission | null;
};

export interface PrepareTurnStartParams {
  agent: StoredAgent;
  agentId: string;
  content: string;
  mode: TurnMode;
  conversationId?: string;
  requestedTurnId?: string;
  requireExistingConversation?: boolean;
  createMissingConversationWithRequestedId?: boolean;
  emitUserMessageEvent?: boolean;
  turnSecrets?: TurnSecrets;
  /**
   * Budget-attribution tags. Fixed at conversation creation (merged over the
   * agent's metadata.defaultTags); conflicting tags on an existing
   * conversation are rejected (TagConflictError).
   */
  tags?: Record<string, string>;
}

export interface PreparedTurnStart {
  agentDef: AgentDefinition;
  conversationId: string;
  turnId: string;
  messageId: string;
  messages: ReturnType<typeof mapMessagesToInternal>;
  mode: TurnMode;
  taskDescription: string;
  turnSecrets?: TurnSecrets;
  concurrencyReservation?: ConcurrencyReservation;
  suppressTurnStartedEvent?: boolean;
  deliveryContext?: TurnDeliveryContext;
}

export interface RedispatchQueuedTurnParams {
  turnId: string;
  agentId: string;
  conversationId: string;
  mode: TurnMode;
  taskDescription: string;
  userMessageId?: string | null;
  messages: ReturnType<typeof mapMessagesToInternal>;
  deliveryContext: TurnDeliveryContext;
}

const REDISPATCH_CONCURRENCY_ATTEMPTS = 3;

async function emitStartupEvent<K extends Parameters<TypedEventBus['emit']>[0]>(
  eventBus: ExecutionDeps['eventBus'],
  event: K,
  payload: Parameters<TypedEventBus['emit']>[1],
): Promise<void> {
  if (!eventBus) return;

  if (eventBus.emitAsync) {
    await eventBus.emitAsync(event, payload as never);
    return;
  }

  await eventBus.emit(event, payload as never);
}

export class TurnStartupService {
  private executionDeps: ExecutionDeps | null = null;
  private turnFinalizer: TurnFinalizer | null = null;
  private dispatchKick: (() => void) | null = null;
  private readonly pendingDispatchHooks = new Map<string, { onSuccess?: () => void }>();
  private readonly processStartedAtMs = Date.now();

  constructor(private readonly deps: TurnStartupServiceDeps) {}

  configureExecution(deps: ExecutionDeps): void {
    this.executionDeps = deps;
    this.turnFinalizer = deps.eventBus?.emitAsync
      ? new TurnFinalizer({
        db: deps.db,
        eventBus: { emitAsync: deps.eventBus.emitAsync.bind(deps.eventBus) },
        logger: this.deps.logger,
      })
      : null;
  }

  async prepareTurnStart(params: PrepareTurnStartParams): Promise<PreparedTurnStart> {
    const executionDeps = this.getExecutionDeps();
    const {
      agent,
      agentId,
      content,
      mode,
      conversationId,
      requestedTurnId,
      requireExistingConversation = false,
      createMissingConversationWithRequestedId = false,
      emitUserMessageEvent = mode === 'interactive',
      turnSecrets,
    } = params;

    if (!agent.harness) {
      throw new Error('Agent harness is not set');
    }

    const agentDef = buildAgentDefinition(agent);
    const configuredMode = agentDef.mode;
    if (configuredMode && configuredMode !== 'both' && configuredMode !== mode) {
      throw new AgentModeNotAllowedError(configuredMode, mode);
    }

    // Attribution tags are sticky per conversation: fixed at creation from
    // agent defaults + caller tags, and conflicting caller tags on an
    // existing conversation are rejected (2026-07-15 budget decisions).
    const agentMetadata = agent.metadata as Record<string, unknown> | null;
    const callerTags = params.tags ?? {};
    let conversationTags: Record<string, string>;
    const existingConversation = conversationId
      ? await executionDeps.db.getConversation(conversationId)
      : undefined;
    if (existingConversation && existingConversation.agentId === agentId) {
      const storedTags = existingConversation.tags ?? {};
      for (const [key, value] of Object.entries(callerTags)) {
        if (storedTags[key] !== value) {
          throw new TagConflictError(existingConversation.id, key, storedTags[key] ?? '(unset)', value);
        }
      }
      conversationTags = storedTags;
    } else {
      conversationTags = { ...readDefaultTags(agentMetadata), ...callerTags };
    }
    const turnTags: Record<string, string> = {
      ...conversationTags,
      agent: agentId,
      harness: agent.harness,
      mode,
    };

    // Budget admission runs before any writes so a blocked run leaves no
    // message or turn behind. Deliberate outcomes (budget exceeded, tag not
    // provisioned) propagate; evaluator faults fail open inside the enforcer.
    if (executionDeps.budgetEnforcer) {
      await executionDeps.budgetEnforcer.checkAdmission({
        agentId,
        tags: turnTags,
        budgetDimensions: readBudgetDimensions(agentMetadata),
      });
    }

    // Queue admission (ctx-z5k0) also runs before any write: a queue_full
    // rejection leaves no message and no turn behind — the caller owns the
    // retry with nothing half-accepted. Redispatches never pass through here.
    if (executionDeps.queueAdmission) {
      await executionDeps.queueAdmission.check(agentId);
    }

    const resolvedConversationId = await this.resolveConversationId(
      executionDeps.db,
      agentId,
      conversationId,
      requireExistingConversation,
      createMissingConversationWithRequestedId,
      conversationTags,
    );

    const allocatedTurnId = requestedTurnId
      ?? this.deps.allocateTurnId?.()
      ?? randomUUID();
    if (requestedTurnId) {
      const existingTurn = await executionDeps.db.getTurn(allocatedTurnId);
      if (existingTurn) {
        throw new Error(`Turn already exists for id ${requestedTurnId}`);
      }
    }
    const gatewayAttribution = resolveModelGatewayTurnAttribution({
      harness: agentDef.harness,
      harnessConfig: agentDef.harnessConfig,
      gateway: this.deps.modelGateway ?? { enabled: false },
      turnId: allocatedTurnId,
    });

    const message = await executionDeps.db.addMessage({
      agentId,
      conversationId: resolvedConversationId,
      role: 'user',
      content,
    });

    let turn: Awaited<
      ReturnType<ExecutionDeps['db']['createTurnWithSecretEnvelope']>
    >;
    let concurrencyReservation: ConcurrencyReservation | undefined;
    try {
      concurrencyReservation = executionDeps.sessionManager?.reserveConcurrencySlot
        ? executionDeps.sessionManager.reserveConcurrencySlot(agentId)
        : undefined;
      if (!concurrencyReservation) {
        executionDeps.sessionManager?.checkConcurrencyLimit(agentId);
      }
      const secretEnvelope = this.deps.turnSecretEnvelopeCodec.seal(
        allocatedTurnId,
        turnSecrets ?? {},
      );
      turn = await executionDeps.db.createTurnWithSecretEnvelope({
        id: allocatedTurnId,
        agentId,
        conversationId: resolvedConversationId,
        mode,
        status: 'queued',
        userMessageId: message.id,
        tags: turnTags,
        ...(gatewayAttribution.mode !== 'direct'
          ? {
            gatewayCorrelationId: gatewayAttribution.correlationId,
            gatewayProfile: gatewayAttribution.profile,
            gatewayRevision: gatewayAttribution.revision,
            gatewayMode: gatewayAttribution.mode,
          }
          : {}),
        ...(mode === 'background' ? { taskDescription: content } : {}),
      }, secretEnvelope);
    } catch (err) {
      concurrencyReservation?.release();
      await executionDeps.db.deleteMessage(message.id).catch((deleteErr) => {
        this.deps.logger.error('[TurnStartupService] failed to rollback user message %s:', message.id, deleteErr);
      });
      throw err;
    }

    try {
      if (emitUserMessageEvent) {
        await emitStartupEvent(executionDeps.eventBus, 'user.message', {
          turnId: turn.id,
          agentId,
          conversationId: resolvedConversationId,
          messageId: message.id,
          content,
          timestamp: Date.now(),
        });
      }

      await emitStartupEvent(executionDeps.eventBus, 'turn.pending', {
        turnId: turn.id,
        agentId,
        conversationId: resolvedConversationId,
        mode,
        ...(mode === 'background' ? { taskDescription: content } : {}),
        timestamp: Date.now(),
      });

      const allMessages = await executionDeps.db.getMessages(resolvedConversationId);

      return {
        agentDef,
        conversationId: resolvedConversationId,
        turnId: turn.id,
        messageId: message.id,
        messages: mapMessagesToInternal(allMessages, agentId),
        mode,
        taskDescription: content,
        turnSecrets,
        concurrencyReservation,
      };
    } catch (err) {
      concurrencyReservation?.release();
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.getTurnFinalizer().finalize({
        turnId: turn.id,
        agentId,
        conversationId: resolvedConversationId,
        status: 'error',
        error: errorMessage,
      }).catch((updateErr) => {
        this.deps.logger.error('[TurnStartupService] failed to mark startup turn %s failed:', turn.id, updateErr);
      });
      await executionDeps.db.deleteMessage(message.id).catch((deleteErr) => {
        this.deps.logger.error('[TurnStartupService] failed to rollback user message %s after turn creation:', message.id, deleteErr);
      });
      throw err;
    }
  }

  /**
   * Launch a prepared run. The single launch contract for every entry point
   * (ctx-smm): the returned promise never rejects — failures are logged and
   * the turn is marked failed; `onSuccess` fires only after the session
   * completed without error.
   */
  launchPreparedTurn(
    start: PreparedTurnStart,
    agentId: string,
    options?: { onSuccess?: () => void; signal?: AbortSignal },
  ): Promise<void> {
    const executionDeps = this.getExecutionDeps();
    const executeParams: Parameters<AgentTurnService['executeTurn']>[0] = {
      agentDef: start.agentDef,
      messages: start.messages,
      agentId,
      conversationId: start.conversationId,
      turnId: start.turnId,
      mode: start.mode,
      taskDescription: start.taskDescription,
      ...(start.turnSecrets ? { turnSecrets: start.turnSecrets } : {}),
      ...(start.concurrencyReservation ? { concurrencyReservation: start.concurrencyReservation } : {}),
      ...(start.suppressTurnStartedEvent ? { suppressTurnStartedEvent: true } : {}),
      ...(start.deliveryContext ? { deliveryContext: start.deliveryContext } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    };

    return executionDeps.agentTurnService.executeTurn(executeParams).then(() => {
      try {
        options?.onSuccess?.();
      } catch (hookErr) {
        this.deps.logger.error(`[TurnStartupService] onSuccess hook failed for agent ${agentId}, turn ${start.turnId}:`, hookErr);
      }
    }).catch(async (err) => {
      this.deps.logger.error(`[TurnStartupService] executeTurn failed for agent ${agentId}, turn ${start.turnId}:`, err);
      await this.getTurnFinalizer().finalize({
        turnId: start.turnId,
        agentId,
        conversationId: start.conversationId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(start.deliveryContext
          ? { expectedDeliveryFence: start.deliveryContext.fence }
          : {}),
      }).catch((dbErr) => {
        this.deps.logger.error(`[TurnStartupService] failed to finalize turn ${start.turnId} after session error:`, dbErr);
      });
    });
  }

  /**
   * Route a freshly prepared turn to execution (ctx-z5k0). With a dispatcher
   * wired, the durable queued row is the handoff and the dispatcher claims
   * it on its next pass; without one (tests, embedded use) this falls back
   * to the legacy direct launch so behavior is unchanged.
   */
  requestDispatch(
    start: PreparedTurnStart,
    agentId: string,
    options?: { onSuccess?: () => void },
  ): void {
    if (this.dispatchKick) {
      // The durable queued row is the entire handoff: dispatchQueuedTurn takes
      // its own reservation at claim time, so the admission-time reservation
      // must be returned here. Holding it leaks one unit per admitted turn and
      // permanently starves the agent once the leak reaches
      // maxConcurrentSessionsPerAgent (dev2, 2026-08-13: every dispatch
      // returned silent no_capacity with zero real sessions).
      start.concurrencyReservation?.release();
      if (options?.onSuccess) {
        // In-memory only, matching the direct-launch contract it replaces:
        // a crash between enqueue and dispatch also lost the hook before.
        if (this.pendingDispatchHooks.size >= 1_000) {
          const oldest = this.pendingDispatchHooks.keys().next().value;
          if (oldest !== undefined) this.pendingDispatchHooks.delete(oldest);
        }
        this.pendingDispatchHooks.set(start.turnId, { onSuccess: options.onSuccess });
      }
      this.dispatchKick();
      return;
    }
    void this.launchPreparedTurn(start, agentId, options);
  }

  setDispatchKick(kick: () => void): void {
    this.dispatchKick = kick;
  }

  /**
   * Dispatcher claim-and-launch (ctx-z5k0): rehydrates a queued turn from
   * its durable row, takes ONE concurrency reservation attempt (no_capacity
   * leaves the row queued for a later pass — never a permanent error), and
   * launches without awaiting execution. The delivery lease inside
   * executeTurn remains the authoritative claim; losing it is a silent skip.
   */
  async dispatchQueuedTurn(params: {
    turnId: string;
    agentId: string;
    conversationId: string | null;
  }): Promise<'dispatched' | 'no_capacity' | 'skipped'> {
    const executionDeps = this.getExecutionDeps();
    const turn = await executionDeps.db.getTurn(params.turnId);
    if (!turn || turn.status !== 'queued' || turn.completedAt !== null) {
      return 'skipped';
    }
    if (!turn.conversationId || !turn.userMessageId) {
      return 'skipped'; // stranded-shaped; boot reconciliation owns these
    }

    let concurrencyReservation: ConcurrencyReservation | undefined;
    try {
      if (executionDeps.sessionManager?.reserveConcurrencySlot) {
        concurrencyReservation = executionDeps.sessionManager.reserveConcurrencySlot(turn.agentId);
      } else {
        executionDeps.sessionManager?.checkConcurrencyLimit(turn.agentId);
      }
    } catch (err) {
      if (err instanceof ConcurrencyLimitError) {
        return 'no_capacity';
      }
      throw err;
    }

    try {
      const agent = await executionDeps.db.getAgent(turn.agentId);
      if (!agent?.harness) {
        throw new Error(`Agent ${turn.agentId} not found or has no harness for queued turn ${turn.id}`);
      }
      const secretEnvelope = await executionDeps.db.getTurnSecretEnvelope(turn.id);
      if (!secretEnvelope) {
        throw new Error(`Encrypted turn credentials are missing for queued turn ${turn.id}`);
      }
      const turnSecrets = this.deps.turnSecretEnvelopeCodec.open(turn.id, secretEnvelope);
      const rawMessages = await executionDeps.db.getMessages(turn.conversationId);
      const mapped = mapMessagesToInternal(rawMessages, turn.agentId);
      const userMessageIndex = mapped.findIndex((message) => message.id === turn.userMessageId);
      if (userMessageIndex < 0) {
        throw new Error(`Queued turn ${turn.id} user message ${turn.userMessageId} not found`);
      }

      // Turns enqueued before this process booted are crash recoveries: they
      // already emitted their start events in a prior life, and their prompt
      // frames may be missing (crash between message persist and frame
      // ingest). Claim the delivery lease here — the fenced activation path
      // republishes deliveryContext.userMessage idempotently — exactly the
      // old boot-redispatch semantics, minus the boot barrier.
      const preBoot = turn.startedAt < this.processStartedAtMs;
      let deliveryContext: TurnDeliveryContext | undefined;
      let releaseLease: (() => Promise<void>) | undefined;
      let leaseSignal: AbortSignal | undefined;
      if (preBoot) {
        const guard = await acquireTurnDeliveryLease(
          { db: executionDeps.db, logger: this.deps.logger },
          turn.id,
          {},
        );
        if (!guard) {
          concurrencyReservation?.release();
          return 'skipped'; // owned elsewhere (another replica / resume worker)
        }
        releaseLease = guard.release;
        leaseSignal = guard.signal;
        const userMessage = mapped[userMessageIndex];
        deliveryContext = {
          fence: guard.fence,
          ...(turn.mode !== 'background' && userMessage
            ? {
              userMessage: {
                turnId: turn.id,
                agentId: turn.agentId,
                conversationId: turn.conversationId,
                messageId: turn.userMessageId,
                content: userMessage.content ?? '',
                timestamp: userMessage.createdAt instanceof Date
                  ? userMessage.createdAt.getTime()
                  : Date.now(),
              },
            }
            : {}),
        };
      }

      const hooks = this.pendingDispatchHooks.get(turn.id);
      this.pendingDispatchHooks.delete(turn.id);
      const launchOptions = hooks?.onSuccess || leaseSignal
        ? {
          ...(hooks?.onSuccess ? { onSuccess: hooks.onSuccess } : {}),
          ...(leaseSignal ? { signal: leaseSignal } : {}),
        }
        : undefined;
      const launch = this.launchPreparedTurn({
        agentDef: buildAgentDefinition(agent),
        conversationId: turn.conversationId,
        turnId: turn.id,
        messageId: turn.userMessageId,
        messages: mapped.slice(0, userMessageIndex + 1),
        mode: turn.mode === 'background' ? 'background' : 'interactive',
        taskDescription: turn.taskDescription ?? mapped[userMessageIndex]?.content ?? '',
        turnSecrets,
        ...(concurrencyReservation ? { concurrencyReservation } : {}),
        ...(deliveryContext ? { deliveryContext, suppressTurnStartedEvent: true } : {}),
      }, turn.agentId, launchOptions);
      if (releaseLease) {
        const release = releaseLease;
        void launch.finally(() => {
          void release().catch((err) => {
            this.deps.logger.error(`[TurnStartupService] failed to release dispatch lease for turn ${turn.id}:`, err);
          });
        });
      }
      return 'dispatched';
    } catch (err) {
      concurrencyReservation?.release();
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`[TurnStartupService] failed to dispatch queued turn ${params.turnId}:`, err);
      await this.getTurnFinalizer().finalize({
        turnId: params.turnId,
        agentId: params.agentId,
        conversationId: turn.conversationId,
        status: 'error',
        error: errorMessage,
      }).catch((dbErr) => {
        this.deps.logger.error(`[TurnStartupService] failed to finalize queued turn ${params.turnId} after dispatch error:`, dbErr);
      });
      return 'skipped';
    }
  }

  /** Honest queue-residency bound (ctx-z5k0): finalize an expired queued turn. */
  async expireQueuedTurn(turn: { turnId: string; agentId: string; conversationId: string | null }): Promise<void> {
    await this.getTurnFinalizer().finalize({
      turnId: turn.turnId,
      agentId: turn.agentId,
      conversationId: turn.conversationId ?? '',
      status: 'error',
      error: 'Queued turn expired before dispatch (queue_expired). Please retry.',
    });
  }

  async redispatchQueuedTurn(
    params: RedispatchQueuedTurnParams,
    signal: AbortSignal,
  ): Promise<void> {
    const executionDeps = this.getExecutionDeps();
    let concurrencyReservation: ConcurrencyReservation | undefined;

    try {
      signal.throwIfAborted();
      const agent = await executionDeps.db.getAgent(params.agentId);
      if (!agent) {
        throw new Error(`Agent ${params.agentId} not found for queued turn ${params.turnId}`);
      }
      if (!agent.harness) {
        throw new Error(`Agent ${params.agentId} harness is not set`);
      }

      concurrencyReservation = await this.reserveRedispatchConcurrency(params.agentId);
      const secretEnvelope = await executionDeps.db.getTurnSecretEnvelope(
        params.turnId,
      );
      if (!secretEnvelope) {
        throw new Error(
          `Encrypted turn credentials are missing for queued turn ${params.turnId}`,
        );
      }
      const turnSecrets = this.deps.turnSecretEnvelopeCodec.open(
        params.turnId,
        secretEnvelope,
      );
      await this.launchPreparedTurn({
        agentDef: buildAgentDefinition(agent),
        conversationId: params.conversationId,
        turnId: params.turnId,
        messageId: params.userMessageId ?? '',
        messages: params.messages,
        mode: params.mode,
        taskDescription: params.taskDescription,
        turnSecrets,
        ...(concurrencyReservation ? { concurrencyReservation } : {}),
        suppressTurnStartedEvent: true,
        deliveryContext: params.deliveryContext,
      }, params.agentId, { signal });
    } catch (err) {
      concurrencyReservation?.release();
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`[TurnStartupService] failed to redispatch queued turn ${params.turnId}:`, err);
      await this.getTurnFinalizer().finalize({
        turnId: params.turnId,
        agentId: params.agentId,
        conversationId: params.conversationId,
        status: 'error',
        error: errorMessage,
        expectedDeliveryFence: params.deliveryContext.fence,
      }).catch((dbErr) => {
        this.deps.logger.error(`[TurnStartupService] failed to finalize queued turn ${params.turnId} after redispatch error:`, dbErr);
      });
    }
  }

  private getTurnFinalizer(): TurnFinalizer {
    if (!this.turnFinalizer) {
      throw new Error('TurnStartupService requires an awaitable canonical event bus for finalization');
    }
    return this.turnFinalizer;
  }

  private getExecutionDeps(): ExecutionDeps {
    if (!this.executionDeps) {
      throw new Error('TurnStartupService execution dependencies are not configured');
    }

    return this.executionDeps;
  }

  private async reserveRedispatchConcurrency(agentId: string): Promise<ConcurrencyReservation | undefined> {
    const executionDeps = this.getExecutionDeps();
    if (!executionDeps.sessionManager?.reserveConcurrencySlot) {
      executionDeps.sessionManager?.checkConcurrencyLimit(agentId);
      return undefined;
    }

    let lastConcurrencyError: ConcurrencyLimitError | undefined;
    for (let attempt = 1; attempt <= REDISPATCH_CONCURRENCY_ATTEMPTS; attempt++) {
      try {
        return executionDeps.sessionManager.reserveConcurrencySlot(agentId);
      } catch (err) {
        if (!(err instanceof ConcurrencyLimitError)) {
          throw err;
        }
        lastConcurrencyError = err;
        if (attempt === REDISPATCH_CONCURRENCY_ATTEMPTS) {
          break;
        }
        await this.sleep(err.retryAfterSec * 1_000);
      }
    }

    throw lastConcurrencyError ?? new Error(`Concurrency limit reached for agent ${agentId}`);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, ms);
      timeout.unref?.();
    });
  }

  private async resolveConversationId(
    db: ExecutionDeps['db'],
    agentId: string,
    conversationId: string | undefined,
    requireExistingConversation: boolean,
    createMissingConversationWithRequestedId: boolean,
    tags?: Record<string, string>,
  ): Promise<string> {
    const creationTags = tags && Object.keys(tags).length > 0 ? tags : undefined;

    if (!conversationId) {
      if (requireExistingConversation) {
        throw new Error('Conversation id is required');
      }

      const conversation = await db.createConversation(agentId, undefined, creationTags);
      return conversation.id;
    }

    const conversation = await db.getConversation(conversationId);
    if (conversation && conversation.agentId === agentId) {
      return conversation.id;
    }

    if (conversation && conversation.agentId !== agentId) {
      throw new Error(`Conversation ${conversationId} not found for agent ${agentId}`);
    }

    if (createMissingConversationWithRequestedId && !requireExistingConversation) {
      const created = await db.createConversation(agentId, conversationId, creationTags);
      return created.id;
    }

    throw new Error(`Conversation ${conversationId} not found for agent ${agentId}`);
  }
}

export type { StoredAgent };
