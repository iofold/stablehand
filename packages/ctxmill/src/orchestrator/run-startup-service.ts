import type { TypedEventBus } from '../events/bus.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { AgentDefinition } from '../types.js';
import { buildAgentDefinition, type StoredAgent } from './agent-definition.js';
import type { AgentSessionService } from './agent-session-service.js';
import { mapMessagesToInternal } from './routes/agent-helpers.js';
import { ConcurrencyLimitError } from './session-manager/concurrency-limit-error.js';
import type { ConcurrencyReservation } from './session-manager/session-turn-orchestrator.js';
import { withRuntimeSandboxSecrets, type RuntimeSandboxSecrets } from './session-manager/runtime-sandbox-secrets.js';
import { TurnFinalizer } from './turn-finalizer.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface RunStartupServiceDeps {
  logger: Logger;
}

type RunMode = 'interactive' | 'background';

type ExecutionDeps = {
  db: Pick<
    DatabaseRepository,
    'addMessage' | 'createConversation' | 'createTurn' | 'deleteMessage' | 'finalizeTurnIfOpen' | 'getAgent' | 'getConversation' | 'getMessages' | 'getTurn' | 'updateTurn'
  >;
  eventBus?: Pick<TypedEventBus, 'emit'> & Partial<Pick<TypedEventBus, 'emitAsync'>>;
  sessionManager?: {
    checkConcurrencyLimit(agentId: string): void;
    reserveConcurrencySlot?(agentId: string): ConcurrencyReservation;
  } | null;
  agentSessionService: Pick<AgentSessionService, 'executeSession'>;
};

export interface PrepareRunStartParams {
  agent: StoredAgent;
  agentId: string;
  content: string;
  mode: RunMode;
  conversationId?: string;
  requestedTurnId?: string;
  requireExistingConversation?: boolean;
  createMissingConversationWithRequestedId?: boolean;
  emitUserMessageEvent?: boolean;
  sandboxSecrets?: RuntimeSandboxSecrets;
}

export interface PreparedRunStart {
  agentDef: AgentDefinition;
  conversationId: string;
  turnId: string;
  messageId: string;
  messages: ReturnType<typeof mapMessagesToInternal>;
  mode: RunMode;
  taskDescription: string;
  sandboxSecrets?: RuntimeSandboxSecrets;
  concurrencyReservation?: ConcurrencyReservation;
  suppressTurnStartedEvent?: boolean;
}

export interface RedispatchQueuedRunParams {
  turnId: string;
  agentId: string;
  conversationId: string;
  mode: RunMode;
  taskDescription: string;
  userMessageId?: string | null;
  messages: ReturnType<typeof mapMessagesToInternal>;
  emitTurnStarted: boolean;
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

export class RunStartupService {
  private executionDeps: ExecutionDeps | null = null;
  private turnFinalizer: TurnFinalizer | null = null;

  constructor(private readonly deps: RunStartupServiceDeps) {}

  configureExecution(deps: ExecutionDeps): void {
    this.executionDeps = deps;
    this.turnFinalizer = new TurnFinalizer({
      db: deps.db,
      eventBus: deps.eventBus,
      logger: this.deps.logger,
    });
  }

  async prepareRunStart(params: PrepareRunStartParams): Promise<PreparedRunStart> {
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
      sandboxSecrets,
    } = params;

    if (!agent.harness) {
      throw new Error('Agent harness is not set');
    }

    const resolvedConversationId = await this.resolveConversationId(
      executionDeps.db,
      agentId,
      conversationId,
      requireExistingConversation,
      createMissingConversationWithRequestedId,
    );

    if (requestedTurnId) {
      const existingTurn = await executionDeps.db.getTurn(requestedTurnId);
      if (existingTurn) {
        throw new Error(`Turn already exists for id ${requestedTurnId}`);
      }
    }

    const message = await executionDeps.db.addMessage({
      agentId,
      conversationId: resolvedConversationId,
      role: 'user',
      content,
    });

    let turn: Awaited<ReturnType<ExecutionDeps['db']['createTurn']>>;
    let concurrencyReservation: ConcurrencyReservation | undefined;
    try {
      concurrencyReservation = executionDeps.sessionManager?.reserveConcurrencySlot
        ? executionDeps.sessionManager.reserveConcurrencySlot(agentId)
        : undefined;
      if (!concurrencyReservation) {
        executionDeps.sessionManager?.checkConcurrencyLimit(agentId);
      }
      turn = await executionDeps.db.createTurn({
        ...(requestedTurnId ? { id: requestedTurnId } : {}),
        agentId,
        conversationId: resolvedConversationId,
        mode,
        status: 'queued',
        userMessageId: message.id,
        ...(mode === 'background' ? { taskDescription: content } : {}),
      });
    } catch (err) {
      concurrencyReservation?.release();
      await executionDeps.db.deleteMessage(message.id).catch((deleteErr) => {
        this.deps.logger.error('[RunStartupService] failed to rollback user message %s:', message.id, deleteErr);
      });
      throw err;
    }

    try {
      if (emitUserMessageEvent) {
        await emitStartupEvent(executionDeps.eventBus, 'user.message', {
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

      const agentDef = withRuntimeSandboxSecrets(buildAgentDefinition(agent), sandboxSecrets);
      const allMessages = await executionDeps.db.getMessages(resolvedConversationId);

      return {
        agentDef,
        conversationId: resolvedConversationId,
        turnId: turn.id,
        messageId: message.id,
        messages: mapMessagesToInternal(allMessages, agentId),
        mode,
        taskDescription: content,
        sandboxSecrets,
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
        this.deps.logger.error('[RunStartupService] failed to mark startup turn %s failed:', turn.id, updateErr);
      });
      await executionDeps.db.deleteMessage(message.id).catch((deleteErr) => {
        this.deps.logger.error('[RunStartupService] failed to rollback user message %s after turn creation:', message.id, deleteErr);
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
  launchPreparedRun(
    start: PreparedRunStart,
    agentId: string,
    options?: { onSuccess?: () => void },
  ): Promise<void> {
    const executionDeps = this.getExecutionDeps();
    const executeParams: Parameters<AgentSessionService['executeSession']>[0] = {
      agentDef: start.agentDef,
      messages: start.messages,
      agentId,
      conversationId: start.conversationId,
      sessionId: start.turnId,
      mode: start.mode,
      taskDescription: start.taskDescription,
      ...(start.sandboxSecrets ? { sandboxSecrets: start.sandboxSecrets } : {}),
      ...(start.concurrencyReservation ? { concurrencyReservation: start.concurrencyReservation } : {}),
      ...(start.suppressTurnStartedEvent ? { suppressTurnStartedEvent: true } : {}),
    };

    return executionDeps.agentSessionService.executeSession(executeParams).then(() => {
      try {
        options?.onSuccess?.();
      } catch (hookErr) {
        this.deps.logger.error(`[RunStartupService] onSuccess hook failed for agent ${agentId}, turn ${start.turnId}:`, hookErr);
      }
    }).catch(async (err) => {
      this.deps.logger.error(`[RunStartupService] executeSession failed for agent ${agentId}, turn ${start.turnId}:`, err);
      await this.getTurnFinalizer().finalize({
        turnId: start.turnId,
        agentId,
        conversationId: start.conversationId,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }).catch((dbErr) => {
        this.deps.logger.error(`[RunStartupService] failed to finalize turn ${start.turnId} after session error:`, dbErr);
      });
    });
  }

  async redispatchQueuedRun(params: RedispatchQueuedRunParams): Promise<void> {
    const executionDeps = this.getExecutionDeps();
    let concurrencyReservation: ConcurrencyReservation | undefined;

    try {
      const agent = await executionDeps.db.getAgent(params.agentId);
      if (!agent) {
        throw new Error(`Agent ${params.agentId} not found for queued turn ${params.turnId}`);
      }
      if (!agent.harness) {
        throw new Error(`Agent ${params.agentId} harness is not set`);
      }

      concurrencyReservation = await this.reserveRedispatchConcurrency(params.agentId);
      await this.launchPreparedRun({
        agentDef: buildAgentDefinition(agent),
        conversationId: params.conversationId,
        turnId: params.turnId,
        messageId: params.userMessageId ?? '',
        messages: params.messages,
        mode: params.mode,
        taskDescription: params.taskDescription,
        ...(concurrencyReservation ? { concurrencyReservation } : {}),
        suppressTurnStartedEvent: !params.emitTurnStarted,
      }, params.agentId);
    } catch (err) {
      concurrencyReservation?.release();
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`[RunStartupService] failed to redispatch queued turn ${params.turnId}:`, err);
      await this.getTurnFinalizer().finalize({
        turnId: params.turnId,
        agentId: params.agentId,
        conversationId: params.conversationId,
        status: 'error',
        error: errorMessage,
      }).catch((dbErr) => {
        this.deps.logger.error(`[RunStartupService] failed to finalize queued turn ${params.turnId} after redispatch error:`, dbErr);
      });
    }
  }

  private getTurnFinalizer(): TurnFinalizer {
    if (!this.turnFinalizer) {
      throw new Error('RunStartupService execution dependencies are not configured');
    }
    return this.turnFinalizer;
  }

  private getExecutionDeps(): ExecutionDeps {
    if (!this.executionDeps) {
      throw new Error('RunStartupService execution dependencies are not configured');
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
  ): Promise<string> {
    if (!conversationId) {
      if (requireExistingConversation) {
        throw new Error('Conversation id is required');
      }

      const conversation = await db.createConversation(agentId);
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
      const created = await db.createConversation(agentId, conversationId);
      return created.id;
    }

    throw new Error(`Conversation ${conversationId} not found for agent ${agentId}`);
  }
}

export type { StoredAgent };
