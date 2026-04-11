import { randomUUID } from 'node:crypto';

import type { DatabaseRepository } from '../../database/repository.js';
import type { AgentDefinition, Message } from '../../types.js';
import type { SessionEvent } from '../session-turn-service.js';
import type { InterruptResumePort, SessionStatePort } from './ports.js';
import type { Logger } from './types.js';

const TAG = '[SandboxSessionManager]';

type PendingRequest = {
  type: string;
  id: string;
  payload: { tool?: unknown; args?: unknown };
};

interface InterruptResumeServiceDeps {
  db: Pick<DatabaseRepository, 'getSandboxSession' | 'getResolvedInterruptsForSession' | 'getCheckpointV2' | 'addMessage'>;
  stateStore: Pick<SessionStatePort, 'getAgentDef' | 'setAgentDef'>;
  logger: Logger;
  ensureSession: (conversationId: string, agentDef: AgentDefinition, agentId: string) => Promise<{ sessionId: string }>;
  deliverTurn: (sessionId: string, messages: Message[], turnId: string) => AsyncGenerator<SessionEvent>;
  resolveAgentDefinition: (agentId: string) => Promise<AgentDefinition | null>;
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

  return definition;
}

export class InterruptResumeService implements InterruptResumePort {
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
    const record = await this.deps.ensureSession(conversationId, agentDef, agentId);

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
    const resolutionContent = interrupt.resolvedAction === 'approve' ? 'APPROVED' : 'REJECTED';

    const continuationMessages: Message[] = [];
    for (const approval of pendingApprovals) {
      const toolArgs = {
        tool: approval.payload.tool,
        args: approval.payload.args,
      };

      await this.deps.db.addMessage({
        agentId,
        conversationId,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: approval.id,
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
        toolCallId: approval.id,
      });

      continuationMessages.push({
        id: `hitl-assistant-${randomUUID().slice(0, 8)}`,
        agentId,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: approval.id,
          name: 'request-approval',
          arguments: toolArgs,
        }],
        createdAt: new Date(),
      });
      continuationMessages.push({
        id: `hitl-tool-${randomUUID().slice(0, 8)}`,
        agentId,
        role: 'tool',
        content: resolutionContent,
        toolCallId: approval.id,
        createdAt: new Date(),
      });
    }

    if (continuationMessages.length === 0) {
      const fallbackToolCallId = interrupt.toolCallId || `hitl-${turnId}`;
      const fallbackArgs = typeof interrupt.args === 'object' && interrupt.args !== null
        ? interrupt.args as Record<string, unknown>
        : { value: interrupt.args };

      await this.deps.db.addMessage({
        agentId,
        conversationId,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: fallbackToolCallId,
          name: 'request-approval',
          args: JSON.stringify(fallbackArgs),
          status: 'complete',
        }],
      });
      await this.deps.db.addMessage({
        agentId,
        conversationId,
        role: 'tool',
        content: resolutionContent,
        toolCallId: fallbackToolCallId,
      });

      continuationMessages.push({
        id: `hitl-assistant-${randomUUID().slice(0, 8)}`,
        agentId,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: fallbackToolCallId,
          name: 'request-approval',
          arguments: fallbackArgs,
        }],
        createdAt: new Date(),
      });
      continuationMessages.push({
        id: `hitl-tool-${randomUUID().slice(0, 8)}`,
        agentId,
        role: 'tool',
        content: resolutionContent,
        toolCallId: fallbackToolCallId,
        createdAt: new Date(),
      });
    }

    const continuationTurnId = `hitl-resume-${turnId.slice(0, 8)}-${Date.now()}`;
    this.deps.logger.info(
      `${TAG} delivering continuation turn ${continuationTurnId} for session ${record.sessionId}`,
    );

    for await (const _event of this.deps.deliverTurn(record.sessionId, continuationMessages, continuationTurnId)) {
      void _event;
    }

    this.deps.logger.info(
      `${TAG} continuation turn ${continuationTurnId} completed for session ${record.sessionId}`,
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

  parsePendingRequestPayload(rawPayload: unknown): { tool?: unknown; args?: unknown } {
    if (isRecord(rawPayload)) {
      return rawPayload;
    }

    if (typeof rawPayload !== 'string') {
      return {};
    }

    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
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

    this.deps.logger.warn(
      `${TAG} agent definition cache miss for conversation ${conversationId} / agent ${agentId}; continuing with degraded minimal stub`,
    );
    const degradedAgentDef: AgentDefinition = {
      name: agentId,
      harness: harnessName,
      harnessConfig: {},
      tools: [],
      systemPrompt: '',
    };
    this.deps.stateStore.setAgentDef(conversationId, degradedAgentDef);
    return degradedAgentDef;
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
