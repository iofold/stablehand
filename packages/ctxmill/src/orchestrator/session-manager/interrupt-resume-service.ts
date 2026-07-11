import { randomUUID } from 'node:crypto';

import type { DatabaseRepository } from '../../database/repository.js';
import type { AgentDefinition, Message } from '@ctxmill/sandbox-daemon';
import type { SessionEvent } from '../session-turn-service.js';
import type { SessionStatePort } from './ports.js';
import type { Logger } from './types.js';

const TAG = '[SandboxSessionManager]';

type PendingRequest = {
  type: string;
  id: string;
  payload: Record<string, unknown>;
};

interface InterruptResumeServiceDeps {
  db: Pick<DatabaseRepository, 'getSandboxSession' | 'getResolvedInterruptsForSession' | 'getCheckpointV2' | 'addMessage'>;
  stateStore: Pick<SessionStatePort, 'getAgentDef' | 'setAgentDef'>;
  logger: Logger;
  ensureSession: (conversationId: string, agentDef: AgentDefinition, agentId: string) => Promise<{ sessionId: string }>;
  deliverTurn: (sessionId: string, messages: Message[], turnId: string) => AsyncGenerator<SessionEvent>;
  resolveAgentDefinition: (agentId: string) => Promise<AgentDefinition | null>;
  /**
   * Terminalize the original (interrupted) turn after a successful durable
   * continuation — the in-process generator that would have completed it is
   * gone after a restart, so the continuation is what actually finishes the
   * turn's lifecycle (ctx-8nnu).
   */
  finalizeOriginalTurn?: (turnId: string, agentId: string, conversationId: string) => Promise<void>;
}

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
  if (isRecord(candidate.nativeTools)) {
    definition.nativeTools = candidate.nativeTools as AgentDefinition['nativeTools'];
  }
  if (isRecord(candidate.workspaceContent)) {
    definition.workspaceContent = candidate.workspaceContent as AgentDefinition['workspaceContent'];
  }

  return definition;
}

function resolutionContentForAction(action: string | null | undefined): string {
  return action === 'approve' ? 'APPROVED' : 'REJECTED';
}

function buildContinuationTurnId(turnId: string): string {
  return `hitl-resume-${turnId.slice(0, 8)}-${Date.now()}`;
}

function normalizeFallbackArgs(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : { value: args };
}

function buildContinuationMessages(input: {
  agentId: string;
  toolCallId: string;
  toolArgs: Record<string, unknown>;
  resolutionContent: string;
}): Message[] {
  return [
    {
      id: `hitl-assistant-${randomUUID().slice(0, 8)}`,
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
      id: `hitl-tool-${randomUUID().slice(0, 8)}`,
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

  async resumeWithInterruptResolution(
    sessionId: string,
    turnId: string,
    agentId: string,
  ): Promise<void> {
    this.deps.logger.info(
      `${TAG} resuming session ${sessionId} with interrupt resolution (turn=${turnId}, agent=${agentId})`,
    );

    const dbSession = await this.deps.db.getSandboxSession(sessionId);
    if (!dbSession) {
      throw new Error(`Session ${sessionId} not found in database`);
    }

    const conversationId = dbSession.conversationId;
    const checkpoint = await this.deps.db.getCheckpointV2(sessionId);
    const agentDef = await this.resolveAgentDefinition(
      conversationId,
      agentId,
      dbSession.harnessName,
      checkpoint?.checkpointData,
    );

    const resolvedInterrupts = await this.deps.db.getResolvedInterruptsForSession(sessionId);
    const interrupt = resolvedInterrupts.find((entry) => entry.agentSessionId === turnId);
    if (!interrupt) {
      this.deps.logger.warn(
        `${TAG} no resolved interrupt matching turnId=${turnId} for session ${sessionId} (found ${resolvedInterrupts.length} other interrupts), skipping continuation turn`,
      );
      return;
    }

    const pendingApprovals = this.getPendingApprovalRequests(checkpoint?.checkpointData)
      .filter((request) => request.type === 'approval');
    const record = await this.deps.ensureSession(conversationId, agentDef, agentId);
    const resolutionContent = resolutionContentForAction(interrupt.resolvedAction);

    const continuationMessages: Message[] = [];
    const addContinuationMessages = async (
      toolCallId: string,
      toolArgs: Record<string, unknown>,
    ) => {
      await this.deps.db.addMessage({
        agentId,
        conversationId,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: toolCallId,
          name: 'request-approval',
          args: JSON.stringify(toolArgs),
          status: 'complete',
        }],
      });
      await this.deps.db.addMessage({
        agentId,
        conversationId,
        role: 'tool',
        content: resolutionContent,
        toolCallId,
      });
      continuationMessages.push(...buildContinuationMessages({
        agentId,
        toolCallId,
        toolArgs,
        resolutionContent,
      }));
    };

    for (const approval of pendingApprovals) {
      const toolArgs = {
        tool: approval.payload.tool,
        args: approval.payload.args,
      };
      await addContinuationMessages(approval.id, toolArgs);
    }

    if (continuationMessages.length === 0) {
      const fallbackToolCallId = interrupt.toolCallId || `hitl-${turnId}`;
      const fallbackArgs = normalizeFallbackArgs(interrupt.args);
      await addContinuationMessages(fallbackToolCallId, fallbackArgs);
    }

    const continuationTurnId = buildContinuationTurnId(turnId);
    this.deps.logger.info(
      `${TAG} delivering continuation turn ${continuationTurnId} for session ${record.sessionId}`,
    );

    for await (const _event of this.deps.deliverTurn(record.sessionId, continuationMessages, continuationTurnId)) {
      void _event;
    }

    this.deps.logger.info(
      `${TAG} continuation turn ${continuationTurnId} completed for session ${record.sessionId}`,
    );

    await this.deps.finalizeOriginalTurn?.(turnId, agentId, conversationId);
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
