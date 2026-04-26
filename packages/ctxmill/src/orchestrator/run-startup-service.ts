import { dirname } from 'node:path';

import type { TypedEventBus } from '../events/bus.js';
import type { DatabaseRepository } from '../database/repository.js';
import type { AgentDefinition, AgentResourceLimits } from '../types.js';
import type { AgentSessionService } from './agent-session-service.js';
import { mapMessagesToInternal } from './routes/agent-helpers.js';
import { withRuntimeSandboxSecrets, type RuntimeSandboxSecrets } from './session-manager/runtime-sandbox-secrets.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface RunStartupServiceDeps {
  logger: Logger;
}

type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

type NativeTools = { allowlist?: string[]; blocklist?: string[] };
type WorkspaceContent = { files?: Array<{ src: string; dest: string }> };
type RunMode = 'interactive' | 'background';

type ExecutionDeps = {
  db: Pick<
    DatabaseRepository,
    'addMessage' | 'createConversation' | 'createTurn' | 'deleteMessage' | 'getConversation' | 'getMessages' | 'getTurn' | 'updateTurn'
  >;
  eventBus?: Pick<TypedEventBus, 'emit'>;
  sessionManager?: { checkConcurrencyLimit(agentId: string): void } | null;
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
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RunStartupService {
  private executionDeps: ExecutionDeps | null = null;

  constructor(private readonly deps: RunStartupServiceDeps) {}

  configureExecution(deps: ExecutionDeps): void {
    this.executionDeps = deps;
  }

  buildAgentDefinition(agent: StoredAgent): AgentDefinition {
    this.deps.logger.debug('Building startup agent definition for %s', agent.name);

    const harnessConfig = this.parseHarnessConfig(agent.harnessConfig);
    const resourceLimits = this.resolveResourceLimits(agent);
    const { nativeTools, workspaceContent } = this.extractManifestFields(agent);
    const workspaceDir = agent.workspaceDir ?? undefined;

    return {
      name: agent.name,
      harness: agent.harness,
      harnessConfig,
      tools: agent.tools,
      systemPrompt: agent.systemPrompt,
      description: agent.description ?? undefined,
      metadata: agent.metadata ?? undefined,
      workspaceDir,
      projectDir: workspaceDir ? dirname(workspaceDir) : undefined,
      resourceLimits,
      ...(nativeTools ? { nativeTools } : {}),
      ...(workspaceContent ? { workspaceContent } : {}),
    };
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
    try {
      executionDeps.sessionManager?.checkConcurrencyLimit(agentId);
      turn = await executionDeps.db.createTurn({
        ...(requestedTurnId ? { id: requestedTurnId } : {}),
        agentId,
        conversationId: resolvedConversationId,
        mode,
        ...(mode === 'background' ? { taskDescription: content } : {}),
      });
    } catch (err) {
      await executionDeps.db.deleteMessage(message.id).catch((deleteErr) => {
        this.deps.logger.error('[RunStartupService] failed to rollback user message %s:', message.id, deleteErr);
      });
      throw err;
    }

    if (emitUserMessageEvent && executionDeps.eventBus) {
      executionDeps.eventBus.emit('user.message', {
        agentId,
        conversationId: resolvedConversationId,
        messageId: message.id,
        content,
        timestamp: Date.now(),
      });
    }

    executionDeps.eventBus?.emit('turn.pending', {
      turnId: turn.id,
      agentId,
      conversationId: resolvedConversationId,
      mode,
      ...(mode === 'background' ? { taskDescription: content } : {}),
      timestamp: Date.now(),
    });

    const agentDef = withRuntimeSandboxSecrets(this.buildAgentDefinition(agent), sandboxSecrets);
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
    };
  }

  launchPreparedRun(
    start: PreparedRunStart,
    agentId: string,
    options?: { rethrowOnError?: boolean },
  ): Promise<void> {
    const executionDeps = this.getExecutionDeps();

    return executionDeps.agentSessionService.executeSession({
      agentDef: start.agentDef,
      messages: start.messages,
      agentId,
      conversationId: start.conversationId,
      sessionId: start.turnId,
      mode: start.mode,
      taskDescription: start.taskDescription,
      sandboxSecrets: start.sandboxSecrets,
    }).catch(async (err) => {
      this.deps.logger.error(`[RunStartupService] executeSession failed for agent ${agentId}, turn ${start.turnId}:`, err);
      await executionDeps.db.updateTurn(start.turnId, {
        completedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }).catch((dbErr) => {
        this.deps.logger.error(`[RunStartupService] failed to update turn ${start.turnId} after session error:`, dbErr);
      });
      if (options?.rethrowOnError) {
        throw err;
      }
    });
  }

  parseHarnessConfig(configJson: string | null | undefined): Record<string, unknown> {
    if (!configJson) {
      return {};
    }

    const parsed = JSON.parse(configJson) as unknown;
    if (!isObjectRecord(parsed)) {
      throw new Error('Stored harnessConfig must be a JSON object');
    }
    return parsed;
  }

  resolveResourceLimits(agent: StoredAgent): AgentResourceLimits | undefined {
    const manifest = isObjectRecord(agent.manifest) ? agent.manifest : undefined;
    const manifestSpec = isObjectRecord(manifest?.spec) ? manifest.spec : undefined;
    const metadata = isObjectRecord(agent.metadata) ? agent.metadata : undefined;

    return (manifest?.resourceLimits ??
      manifestSpec?.resources ??
      metadata?.resourceLimits) as AgentResourceLimits | undefined;
  }

  extractManifestFields(agent: StoredAgent): {
    nativeTools?: NativeTools;
    workspaceContent?: WorkspaceContent;
  } {
    const manifest = isObjectRecord(agent.manifest) ? agent.manifest : undefined;
    const manifestSpec = isObjectRecord(manifest?.spec) ? manifest.spec : undefined;
    const metadata = isObjectRecord(agent.metadata) ? agent.metadata : {};
    const workspace = isObjectRecord(manifestSpec?.workspace) ? manifestSpec.workspace : undefined;

    const nativeTools = ('nativeTools' in metadata
      ? metadata.nativeTools
      : manifestSpec?.nativeTools) as NativeTools | undefined;
    const workspaceContent = workspace?.content as WorkspaceContent | undefined;

    return {
      ...(nativeTools ? { nativeTools } : {}),
      ...(workspaceContent ? { workspaceContent } : {}),
    };
  }

  private getExecutionDeps(): ExecutionDeps {
    if (!this.executionDeps) {
      throw new Error('RunStartupService execution dependencies are not configured');
    }

    return this.executionDeps;
  }

  private async resolveConversationId(
    db: ExecutionDeps['db'],
    agentId: string,
    conversationId: string | undefined,
    requireExistingConversation: boolean,
  ): Promise<string> {
    if (!conversationId) {
      if (requireExistingConversation) {
        throw new Error('Conversation id is required');
      }

      const conversation = await db.createConversation(agentId);
      return conversation.id;
    }

    const conversation = await db.getConversation(conversationId);
    if (!conversation || conversation.agentId !== agentId) {
      throw new Error(`Conversation ${conversationId} not found for agent ${agentId}`);
    }

    return conversation.id;
  }
}

export type { StoredAgent };
