import { seedAgentWorkspace } from '../../../workspace/ensure.js';
import type { TurnSelect } from '../../../database/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiSessionStatusCounts } from '@ctxmill/shared';

import { getAgentHttpToolProviderName, registerAgentHttpTools } from '../../http-tools.js';
import {
  ensureAgentWorkspace,
  getRequestAgent,
  mergeToolNames,
  toAgentResponse,
  toApiAgentSession,
  validateHarnessConfigInput,
  validateHttpTools,
  validateResourceLimits,
  isNonEmptyString,
  isObjectRecord,
} from './helpers.js';
import type { AgentHttpToolDefinition, AgentRouteBody, AgentSubRouteOptions, StoredAgent } from './types.js';

const defaultSessionCounts = (): ApiSessionStatusCounts => ({
  ACTIVE: 0,
  CHECKPOINTED: 0,
  RESTORING: 0,
  TERMINATED: 0,
});

type LegacyModelFields = {
  model?: unknown;
  modelConfig?: unknown;
};

type AgentCreateRouteBody = AgentRouteBody & LegacyModelFields & {
  manifest?: Record<string, unknown>;
};

type AgentUpdateRouteBody = AgentRouteBody & LegacyModelFields;

function buildAgentSummary(
  agent: StoredAgent,
  opts: {
    allRuns: TurnSelect[];
    activeRuns: TurnSelect[];
    conversationCount: number;
    sessionsByStatus: ApiSessionStatusCounts;
  },
  deps: Pick<AgentSubRouteOptions, 'sse' | 'interrupts'>,
): Record<string, unknown> {
  const completedTurns = opts.allRuns.filter((run) => run.completedAt !== null && !run.error).length;
  const failedTurns = opts.allRuns.filter((run) => !!run.error).length;
  const recentTurns = [...opts.allRuns]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5);

  return {
    ...toAgentResponse(agent),
    // Derived at read from open turns (ctx-1xb); the stored column is vestigial.
    status: opts.activeRuns.length > 0 ? 'running' : 'idle',
    sseClients: deps.sse.getClientCount(agent.id),
    hasPendingInterrupt: deps.interrupts.hasPendingForAgent(agent.id),
    // One counter per concept (ctx-ohq4): conversations, turns, sandbox sessions.
    conversationCount: opts.conversationCount,
    turnCount: opts.allRuns.length,
    completedTurnCount: completedTurns,
    failedTurnCount: failedTurns,
    activeTurnCount: opts.activeRuns.length,
    recentTurns: recentTurns.map((turn) => toApiAgentSession(turn)),
    sessionsByStatus: opts.sessionsByStatus,
  };
}

export async function crudRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const {
    db,
    sse,
    interrupts,
    harnessSchemas,
    eventBus,
    dataDir,
    secretProvider,
    toolRegistry,
    containerManager,
    sessionManager,
    loadAgent,
  } = opts;

  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const agentList = await db.listAgents();
    const [conversationCounts, sessionStatusMap] = await Promise.all([
      Promise.all(agentList.map((agent) => db.getConversationCount(agent.id))),
      db.getSessionStatusCountsByAgent(),
    ]);

    const enriched = agentList.map(async (agent, idx) => {
      const allRunsPromise = db.getTurnsByAgent(agent.id);
      const activeRunsPromise = db.getActiveTurnsForAgent(agent.id);
      const [allRuns, activeRuns] = await Promise.all([allRunsPromise, activeRunsPromise]);

      return {
        ...buildAgentSummary(agent, {
          allRuns,
          activeRuns,
          conversationCount: conversationCounts[idx],
          sessionsByStatus: sessionStatusMap.get(agent.id) ?? defaultSessionCounts(),
        }, { sse, interrupts }),
        lastActivity: sse.getLastActivity(agent.id) ?? null,
      };
    });

    return reply.send(await Promise.all(enriched));
  });

  app.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: AgentCreateRouteBody | undefined;
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body;

      if (body && ('model' in body || 'modelConfig' in body)) {
        return reply.status(400).send({
          error: 'model and modelConfig are no longer supported; use harness and harnessConfig',
        });
      }

      if (
        !body ||
        typeof body.name !== 'string' || body.name.trim() === '' ||
        !isNonEmptyString(body.harness) ||
        !isObjectRecord(body.harnessConfig) ||
        typeof body.systemPrompt !== 'string' ||
        !Array.isArray(body.tools)
      ) {
        return reply.status(400).send({
          error: 'name, harness, harnessConfig, systemPrompt, and tools are required',
        });
      }

      const validatedHarnessConfig = validateHarnessConfigInput(body.harness, body.harnessConfig, harnessSchemas);
      if (!validatedHarnessConfig.success) {
        return reply.status(validatedHarnessConfig.status).send(validatedHarnessConfig.body);
      }

      if (body.resourceLimits && typeof body.resourceLimits === 'object') {
        const limitsErrors = validateResourceLimits(body.resourceLimits as Record<string, unknown>);
        if (limitsErrors.length > 0) {
          return reply.status(400).send({
            error: 'Invalid resource limits',
            details: limitsErrors,
          });
        }
      }

      const httpToolDefs = body.httpTools;
      const httpToolError = validateHttpTools(httpToolDefs);
      if (httpToolError) {
        return reply.status(400).send({ error: httpToolError });
      }

      const metadata: Record<string, unknown> = { ...(body.metadata ?? {}) };
      if (body.resourceLimits) {
        metadata.resourceLimits = body.resourceLimits;
      }
      if (httpToolDefs !== undefined) {
        metadata.httpTools = httpToolDefs;
      }

      const toolNames = mergeToolNames(body.tools, httpToolDefs);

      let agent = await db.createAgent({
        name: body.name,
        harness: body.harness,
        harnessConfig: JSON.stringify(validatedHarnessConfig.harnessConfig),
        systemPrompt: body.systemPrompt,
        tools: toolNames,
        description: body.description ?? null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        ...(body.manifest && typeof body.manifest === 'object'
          ? { manifest: body.manifest }
          : {}),
      });

      const workspaceDir = ensureAgentWorkspace(agent.id, { dataDir });
      if (workspaceDir) {
        seedAgentWorkspace(workspaceDir);
        if (!agent.workspaceDir) {
          await db.updateAgent(agent.id, { workspaceDir });
          agent = { ...agent, workspaceDir };
        }
      }

      if (toolRegistry) {
        await registerAgentHttpTools(toolRegistry, agent, secretProvider);
      }

      if (eventBus) {
        eventBus.emit('agent.created', {
          agentId: agent.id,
          name: agent.name,
          timestamp: Date.now(),
        });
      }

      return reply.status(201).send(toAgentResponse(agent));
    },
  );

  app.put(
    '/:id',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: AgentUpdateRouteBody | undefined;
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body;

      if (!body || Object.keys(body).length === 0) {
        return reply.status(400).send({ error: 'Request body must contain at least one field to update' });
      }

      if ('model' in body || 'modelConfig' in body) {
        return reply.status(400).send({
          error: 'model and modelConfig are no longer supported; use harness and harnessConfig',
        });
      }

      if (body.resourceLimits && typeof body.resourceLimits === 'object') {
        const limitsErrors = validateResourceLimits(body.resourceLimits as Record<string, unknown>);
        if (limitsErrors.length > 0) {
          return reply.status(400).send({
            error: 'Invalid resource limits',
            details: limitsErrors,
          });
        }
      }

      const agent = getRequestAgent(request);
      const existingMetadata = (agent.metadata ?? {}) as Record<string, unknown>;
      const existingHttpTools = Array.isArray(existingMetadata.httpTools)
        ? existingMetadata.httpTools as AgentHttpToolDefinition[]
        : undefined;
      const existingHttpToolNames = new Set(existingHttpTools?.map((tool) => tool.name) ?? []);

      const httpToolError = validateHttpTools(body.httpTools);
      if (httpToolError) {
        return reply.status(400).send({ error: httpToolError });
      }

      const updateData: Record<string, unknown> = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.systemPrompt !== undefined) updateData.systemPrompt = body.systemPrompt;
      if (body.description !== undefined) updateData.description = body.description;

      if (body.harness !== undefined && !isNonEmptyString(body.harness)) {
        return reply.status(400).send({ error: 'harness must be a non-empty string' });
      }

      if (body.harness !== undefined && body.harnessConfig === undefined) {
        return reply.status(400).send({ error: 'harnessConfig is required when changing harness' });
      }

      const nextHarness = body.harness ?? agent.harness;
      if (body.harnessConfig !== undefined) {
        const validatedHarnessConfig = validateHarnessConfigInput(nextHarness, body.harnessConfig, harnessSchemas);
        if (!validatedHarnessConfig.success) {
          return reply.status(validatedHarnessConfig.status).send(validatedHarnessConfig.body);
        }

        updateData.harnessConfig = JSON.stringify(validatedHarnessConfig.harnessConfig);
      }

      if (body.harness !== undefined) {
        updateData.harness = body.harness;
      }

      const shouldUpdateTools = body.tools !== undefined || body.httpTools !== undefined;
      if (shouldUpdateTools) {
        const baseTools = (body.tools !== undefined ? body.tools : agent.tools)
          .filter((toolName) => !existingHttpToolNames.has(toolName));
        const nextHttpTools = body.httpTools !== undefined ? body.httpTools : existingHttpTools;
        updateData.tools = mergeToolNames(baseTools, nextHttpTools);
      }

      if (body.resourceLimits !== undefined || body.metadata !== undefined || body.httpTools !== undefined) {
        const newMetadata = body.metadata !== undefined ? { ...body.metadata } : { ...existingMetadata };

        if (body.httpTools === undefined && existingMetadata.httpTools !== undefined) {
          newMetadata.httpTools = existingMetadata.httpTools;
        }

        if (body.resourceLimits === null) {
          delete newMetadata.resourceLimits;
        } else if (body.resourceLimits) {
          newMetadata.resourceLimits = body.resourceLimits;
        }

        if (body.httpTools !== undefined) {
          newMetadata.httpTools = body.httpTools;
        }

        updateData.metadata = Object.keys(newMetadata).length > 0 ? newMetadata : null;
      }

      const updated = await db.updateAgent(id, updateData);

      if (updated && toolRegistry) {
        await registerAgentHttpTools(toolRegistry, updated, secretProvider);
      }

      return reply.send(updated ? toAgentResponse(updated) : updated);
    },
  );

  app.delete(
    '/:id',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      if (toolRegistry) {
        toolRegistry.removeProvider(getAgentHttpToolProviderName(id));
        await toolRegistry.refresh();
      }

      await secretProvider?.deleteForAgent?.(id);

      if (sessionManager) {
        const sessions = await sessionManager.getSessionsByAgent(id);
        for (const session of sessions) {
          if (!session.containerId && session.status === 'TERMINATED') {
            continue;
          }

          try {
            sessionManager.onSessionReconnected(session.conversationId, session);
            await sessionManager.killSession(session.sessionId);
          } catch (err) {
            console.warn(`[agents] failed to clean runtime for agent ${id} session ${session.sessionId}:`, err);
          }
        }
      }

      if (containerManager) {
        const managedContainers = await containerManager.listManagedContainersWithLabels();
        for (const container of managedContainers) {
          if (container.labels['ctxmill.agent-id'] !== id) {
            continue;
          }

          try {
            await containerManager.stopContainer(container.containerId, 10);
          } catch (err) {
            console.warn(`[agents] failed stopping orphan container ${container.containerId} for agent ${id}:`, err);
          }

          try {
            await containerManager.removeContainer(container.containerId, true);
          } catch (err) {
            console.warn(`[agents] failed removing orphan container ${container.containerId} for agent ${id}:`, err);
          }
        }
      }

      await db.deleteAgentCascade(id);

      if (eventBus) {
        eventBus.emit('agent.deleted', {
          agentId: id,
          timestamp: Date.now(),
        });
      }

      return reply.status(204).send();
    },
  );

  app.get(
    '/:id',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const agent = getRequestAgent(request);

      const [conversations, allRuns, activeRuns, sandboxSessions] = await Promise.all([
        db.getConversationsForAgent(id),
        db.getTurnsByAgent(id),
        db.getActiveTurnsForAgent(id),
        db.getSandboxSessionsByAgent(id),
      ]);
      const sessionsByStatus = defaultSessionCounts();
      for (const session of sandboxSessions) {
        const key = session.status as keyof typeof sessionsByStatus;
        if (key in sessionsByStatus) sessionsByStatus[key]++;
      }

      return reply.send(buildAgentSummary(agent, {
        allRuns,
        activeRuns,
        conversationCount: conversations.length,
        sessionsByStatus,
      }, { sse, interrupts }));
    },
  );
}
