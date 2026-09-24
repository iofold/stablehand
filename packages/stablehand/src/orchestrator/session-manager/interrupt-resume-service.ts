import { createHash } from 'node:crypto';

import type { DatabaseRepository } from '../../database/repository.js';
import type { TypedEventBus } from '../../events/bus.js';
import type { AgentDefinition, Message } from '@stablehand/sandbox-daemon';
import { publishMessageCanonicalState } from '../message-publisher.js';
import type {
  TurnDeliveryContext,
  TurnDeliveryFence,
} from '../turn-delivery-fence.js';
import type { SessionStatePort } from './ports.js';
import type { Logger, SessionEnsureOptions } from './types.js';
import type { TurnSecrets } from './turn-secrets.js';

const TAG = '[SandboxSessionManager]';

export interface PendingRequest {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

interface InterruptResumeServiceDeps {
  db: Pick<
    DatabaseRepository,
    | 'getTurn'
    | 'getSandboxSession'
    | 'getInterruptById'
    | 'getCheckpointV2'
    | 'addCanonicalMessage'
    | 'isTurnDeliveryFenceCurrent'
  >;
  eventBus: Pick<TypedEventBus, 'emitAsync'>;
  stateStore: Pick<SessionStatePort, 'getAgentDef' | 'setAgentDef'>;
  logger: Logger;
  ensureSession: (
    conversationId: string,
    agentDef: AgentDefinition,
    agentId: string,
    options?: SessionEnsureOptions,
  ) => Promise<{ sessionId: string }>;
  executeContinuation: (input: InterruptContinuationExecution) => Promise<void>;
  resolveTurnSecrets: (turnId: string) => Promise<TurnSecrets>;
  resolveAgentDefinition: (agentId: string) => Promise<AgentDefinition | null>;
}

export interface InterruptContinuationExecution {
  agentDef: AgentDefinition;
  messages: Message[];
  agentId: string;
  conversationId: string;
  turnId: string;
  mode: 'interactive' | 'background';
  taskDescription: string;
  sandboxSessionId: string;
  continuationAttemptId: string;
  deliveryContext: TurnDeliveryContext;
  turnSecrets: TurnSecrets;
  signal?: AbortSignal;
}

export interface PreparedInterruptContinuationReady {
  kind: 'ready';
  sandboxSessionId: string;
  turnId: string;
  agentId: string;
  interruptId: string;
  conversationId: string;
  mode: 'interactive' | 'background';
  taskDescription: string;
  agentDef: AgentDefinition;
  pendingApprovals: PendingRequest[];
  fallbackToolCallId: string;
  fallbackArgs: Record<string, unknown>;
  resolutionContent: string;
  turnSecrets: TurnSecrets;
}

export interface PreparedInterruptContinuationTerminal {
  kind: 'terminal';
  turnId: string;
}

export type PreparedInterruptContinuation =
  | PreparedInterruptContinuationReady
  | PreparedInterruptContinuationTerminal;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function readAgentDefinitionCandidate(candidate: unknown): AgentDefinition | null {
  if (!isRecord(candidate)) {
    return null;
  }

  const { name, harness, harnessConfig, tools, systemPrompt } = candidate;
  if (
    typeof name !== 'string'
    || typeof harness !== 'string'
    || !isRecord(harnessConfig)
    || !isStringArray(tools)
    || typeof systemPrompt !== 'string'
  ) {
    return null;
  }

  const definition: AgentDefinition = {
    name,
    harness,
    harnessConfig: { ...harnessConfig },
    tools: [...tools],
    systemPrompt,
  };

  if (typeof candidate.description === 'string') {
    definition.description = candidate.description;
  }
  if (isRecord(candidate.metadata)) {
    definition.metadata = candidate.metadata;
  }
  if (typeof candidate.workspaceDir === 'string') {
    definition.workspaceDir = candidate.workspaceDir;
  }
  if (typeof candidate.projectDir === 'string') {
    definition.projectDir = candidate.projectDir;
  }
  if (
    candidate.mode === 'interactive'
    || candidate.mode === 'background'
    || candidate.mode === 'both'
  ) {
    definition.mode = candidate.mode;
  }
  // Runtime-enforced fields must survive the checkpoint fallback (ctx-8l4):
  // dropping them silently loses workspace seeding and resource caps on resume
  // (session-runtime-factory reads them when recreating the sandbox).
  if (isRecord(candidate.resourceLimits)) {
    definition.resourceLimits = candidate.resourceLimits as AgentDefinition['resourceLimits'];
  }
  if (isRecord(candidate.nativeToolPolicy)) {
    definition.nativeToolPolicy = candidate.nativeToolPolicy as AgentDefinition['nativeToolPolicy'];
  }
  if (isRecord(candidate.workspaceContent)) {
    definition.workspaceContent = candidate.workspaceContent as AgentDefinition['workspaceContent'];
  }

  return definition;
}

function resolutionContentForAction(action: string | null | undefined): string {
  return action === 'approve' ? 'APPROVED' : 'REJECTED';
}

function canonicalContinuationMessageId(input: {
  turnId: string;
  interruptId: string;
  toolCallId: string;
  role: 'assistant' | 'tool';
}): string {
  const digest = createHash('sha256')
    .update(`${input.turnId}\0${input.interruptId}\0${input.toolCallId}\0${input.role}`)
    .digest('hex')
    .slice(0, 24);
  return `hitl-${input.role}-${digest}`;
}

function normalizeFallbackArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : { value: args };
}

function buildContinuationMessages(input: {
  agentId: string;
  assistantMessageId: string;
  toolMessageId: string;
  toolCallId: string;
  toolArgs: Record<string, unknown>;
  resolutionContent: string;
}): Message[] {
  return [
    {
      id: input.assistantMessageId,
      agentId: input.agentId,
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: input.toolCallId,
        name: 'request-approval',
        arguments: input.toolArgs,
      }],
      createdAt: new Date(),
    },
    {
      id: input.toolMessageId,
      agentId: input.agentId,
      role: 'tool',
      content: input.resolutionContent,
      toolCallId: input.toolCallId,
      createdAt: new Date(),
    },
  ];
}

export class InterruptResumeService {
  constructor(private readonly deps: InterruptResumeServiceDeps) {}

  async prepareInterruptContinuation(
    sessionId: string,
    turnId: string,
    agentId: string,
    interruptId: string,
    recoveryAuthority?: {
      attemptId: string;
      fence: TurnDeliveryFence;
    },
  ): Promise<PreparedInterruptContinuation> {
    this.deps.logger.info(
      `${TAG} preparing interrupt continuation for session ${sessionId} `
      + `(turn=${turnId}, agent=${agentId})`,
    );

    const originalTurn = await this.deps.db.getTurn(turnId);
    if (!originalTurn) {
      throw new Error(`Turn ${turnId} not found`);
    }
    if (originalTurn.completedAt !== null || (
      originalTurn.status !== 'queued'
      && originalTurn.status !== 'running'
    )) {
      this.deps.logger.info(
        `${TAG} turn ${turnId} is already terminal (${originalTurn.status}); completing resume without redelivery`,
      );
      return { kind: 'terminal', turnId };
    }
    if (originalTurn.status !== 'running') {
      throw new Error(
        `Turn ${turnId} cannot resume interrupt ${interruptId} from status ${originalTurn.status}`,
      );
    }
    if (originalTurn.agentId !== agentId) {
      throw new Error(
        `Turn ${turnId} belongs to agent ${originalTurn.agentId}, not ${agentId}`,
      );
    }
    const dbSession = await this.deps.db.getSandboxSession(sessionId);
    if (!dbSession) {
      throw new Error(`Session ${sessionId} not found in database`);
    }
    if (
      dbSession.agentId !== agentId
      || dbSession.conversationId !== originalTurn.conversationId
    ) {
      throw new Error(
        `Session ${sessionId} does not own turn ${turnId} `
        + `(expected conversation=${originalTurn.conversationId}, agent=${agentId}; `
        + `found conversation=${dbSession.conversationId}, agent=${dbSession.agentId})`,
      );
    }

    const conversationId = dbSession.conversationId;
    const checkpoint = await this.deps.db.getCheckpointV2(sessionId);
    const agentDef = await this.resolveAgentDefinition(
      conversationId,
      agentId,
      dbSession.harnessName,
      checkpoint?.checkpointData,
    );

    const interrupt = await this.deps.db.getInterruptById(interruptId);
    if (!interrupt || interrupt.status !== 'resolved') {
      throw new Error(
        `Resolved interrupt ${interruptId} was not found`,
      );
    }
    if (interrupt.turnId !== turnId || interrupt.agentId !== agentId) {
      throw new Error(
        `Resolved interrupt ${interruptId} does not match continuation ownership `
        + `(expected turn=${turnId}, agent=${agentId}; `
        + `found turn=${interrupt.turnId}, agent=${interrupt.agentId})`,
      );
    }

    const pendingApprovals = this.getPendingApprovalRequests(checkpoint?.checkpointData)
      .filter((request) => request.type === 'approval');
    const turnSecrets = await this.deps.resolveTurnSecrets(turnId);
    const record = await this.deps.ensureSession(
      conversationId,
      agentDef,
      agentId,
      recoveryAuthority
        ? {
            recoveryAuthority: {
              attemptId: recoveryAuthority.attemptId,
              turnId,
              fence: recoveryAuthority.fence,
            },
          }
        : undefined,
    );
    const resolutionContent = resolutionContentForAction(interrupt.resolvedAction);

    return {
      kind: 'ready',
      sandboxSessionId: record.sessionId,
      turnId,
      agentId,
      interruptId,
      conversationId,
      mode: originalTurn.mode === 'background' ? 'background' : 'interactive',
      taskDescription: originalTurn.taskDescription ?? '',
      agentDef,
      pendingApprovals,
      fallbackToolCallId: interrupt.toolCallId || `hitl-${turnId}`,
      fallbackArgs: normalizeFallbackArgs(interrupt.args),
      resolutionContent,
      turnSecrets,
    };
  }

  async executeInterruptContinuation(
    prepared: PreparedInterruptContinuationReady,
    attemptId: string,
    fence: TurnDeliveryFence,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const ownsDelivery = await this.deps.db.isTurnDeliveryFenceCurrent(
      prepared.turnId,
      fence,
    );
    if (!ownsDelivery) {
      throw new Error(
        `HITL continuation ${attemptId} lost delivery ownership before execution`,
      );
    }

    const continuationMessages: Message[] = [];
    const addContinuationMessages = async (
      toolCallId: string,
      toolArgs: Record<string, unknown>,
    ) => {
      const assistantMessage = await this.deps.db.addCanonicalMessage({
        id: canonicalContinuationMessageId({
          turnId: prepared.turnId,
          interruptId: prepared.interruptId,
          toolCallId,
          role: 'assistant',
        }),
        agentId: prepared.agentId,
        conversationId: prepared.conversationId,
        turnId: prepared.turnId,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: toolCallId,
          name: 'request-approval',
          args: JSON.stringify(toolArgs),
          status: 'complete',
        }],
      }, fence);
      if (!assistantMessage) {
        throw new Error(
          `HITL continuation ${attemptId} lost delivery ownership while persisting approval request`,
        );
      }
      await publishMessageCanonicalState(
        { eventBus: this.deps.eventBus },
        assistantMessage,
        { deliveryFence: fence },
      );
      signal?.throwIfAborted();

      const toolMessage = await this.deps.db.addCanonicalMessage({
        id: canonicalContinuationMessageId({
          turnId: prepared.turnId,
          interruptId: prepared.interruptId,
          toolCallId,
          role: 'tool',
        }),
        agentId: prepared.agentId,
        conversationId: prepared.conversationId,
        turnId: prepared.turnId,
        role: 'tool',
        content: prepared.resolutionContent,
        toolCallId,
      }, fence);
      if (!toolMessage) {
        throw new Error(
          `HITL continuation ${attemptId} lost delivery ownership while persisting approval result`,
        );
      }
      await publishMessageCanonicalState(
        { eventBus: this.deps.eventBus },
        toolMessage,
        { deliveryFence: fence },
      );
      continuationMessages.push(...buildContinuationMessages({
        agentId: prepared.agentId,
        assistantMessageId: assistantMessage.id,
        toolMessageId: toolMessage.id,
        toolCallId,
        toolArgs,
        resolutionContent: prepared.resolutionContent,
      }));
    };

    for (const approval of prepared.pendingApprovals) {
      signal?.throwIfAborted();
      const toolArgs = {
        tool: approval.payload.tool,
        args: approval.payload.args,
      };
      await addContinuationMessages(approval.id, toolArgs);
    }

    if (continuationMessages.length === 0) {
      await addContinuationMessages(
        prepared.fallbackToolCallId,
        prepared.fallbackArgs,
      );
    }

    signal?.throwIfAborted();
    const stillOwnsDelivery = await this.deps.db.isTurnDeliveryFenceCurrent(
      prepared.turnId,
      fence,
    );
    if (!stillOwnsDelivery) {
      throw new Error(
        `HITL continuation ${attemptId} lost delivery ownership before agent execution`,
      );
    }
    this.deps.logger.info(
      `${TAG} delivering interrupt continuation ${attemptId} on original turn `
      + `${prepared.turnId} for session ${prepared.sandboxSessionId}`,
    );

    await this.deps.executeContinuation({
      agentDef: prepared.agentDef,
      messages: continuationMessages,
      agentId: prepared.agentId,
      conversationId: prepared.conversationId,
      turnId: prepared.turnId,
      mode: prepared.mode,
      taskDescription: prepared.taskDescription,
      sandboxSessionId: prepared.sandboxSessionId,
      continuationAttemptId: attemptId,
      deliveryContext: { fence },
      turnSecrets: prepared.turnSecrets,
      signal,
    });
    signal?.throwIfAborted();

    this.deps.logger.info(
      `${TAG} interrupt continuation ${attemptId} completed on original turn `
      + `${prepared.turnId} for session ${prepared.sandboxSessionId}`,
    );
  }

  getPendingApprovalRequests(checkpointData: Record<string, unknown> | undefined): PendingRequest[] {
    const runnerState = checkpointData?.runnerState;
    if (!runnerState || typeof runnerState !== 'object') {
      return [];
    }

    const pendingRequests = 'pendingRequests' in runnerState ? runnerState.pendingRequests : undefined;
    if (!Array.isArray(pendingRequests)) {
      return [];
    }

    return pendingRequests.flatMap((request) => {
      if (!request || typeof request !== 'object') {
        return [];
      }

      const type = 'type' in request && typeof request.type === 'string' ? request.type : undefined;
      const id = 'id' in request && typeof request.id === 'string' ? request.id : undefined;
      if (!type || !id) {
        return [];
      }

      const payload = 'payload' in request
        ? this.parsePendingRequestPayload(request.payload)
        : {};

      return [{ type, id, payload }];
    });
  }

  parsePendingRequestPayload(rawPayload: unknown): Record<string, unknown> {
    if (isRecord(rawPayload)) {
      return rawPayload;
    }

    if (typeof rawPayload !== 'string') {
      throw new Error(
        `Malformed HITL checkpoint pending request payload: expected object or JSON object string, got ${typeof rawPayload}`,
      );
    }

    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
      throw new Error(`expected JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    } catch (err) {
      throw new Error(
        `Malformed HITL checkpoint pending request payload JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private async resolveAgentDefinition(
    conversationId: string,
    agentId: string,
    harnessName: string,
    checkpointData: Record<string, unknown> | undefined,
  ): Promise<AgentDefinition> {
    const cachedAgentDef = this.deps.stateStore.getAgentDef(conversationId);
    if (cachedAgentDef) {
      return cachedAgentDef;
    }

    try {
      const resolvedAgentDef = await this.deps.resolveAgentDefinition(agentId);
      if (resolvedAgentDef) {
        this.deps.stateStore.setAgentDef(conversationId, resolvedAgentDef);
        return resolvedAgentDef;
      }
    } catch (err) {
      this.deps.logger.warn(
        `${TAG} failed to resolve agent definition from database for agent ${agentId}:`,
        err,
      );
    }

    const checkpointAgentDef = this.readAgentDefinitionFromCheckpoint(checkpointData);
    if (checkpointAgentDef) {
      this.deps.stateStore.setAgentDef(conversationId, checkpointAgentDef);
      return checkpointAgentDef;
    }

    throw new Error(
      `${TAG} cannot resume session for conversation ${conversationId} / agent ${agentId}: missing agent definition for harness ${harnessName}`,
    );
  }

  private readAgentDefinitionFromCheckpoint(
    checkpointData: Record<string, unknown> | undefined,
  ): AgentDefinition | null {
    if (!checkpointData) {
      return null;
    }

    const candidates: unknown[] = [
      checkpointData.agentDefinition,
      checkpointData.agentDef,
    ];

    const metadata = isRecord(checkpointData.metadata) ? checkpointData.metadata : undefined;
    if (metadata) {
      candidates.push(metadata.agentDefinition, metadata.agentDef);
    }

    const runnerState = isRecord(checkpointData.runnerState) ? checkpointData.runnerState : undefined;
    if (runnerState) {
      candidates.push(runnerState.agentDefinition, runnerState.agentDef);
    }

    for (const candidate of candidates) {
      const definition = readAgentDefinitionCandidate(candidate);
      if (definition) {
        return definition;
      }
    }

    return null;
  }
}
