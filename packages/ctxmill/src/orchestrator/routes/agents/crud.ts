import { seedAgentWorkspace } from '../../../workspace/ensure.js';
import type { AgentResourceLimits } from '../../../types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
import type { AgentHttpToolDefinition, AgentSubRouteOptions } from './types.js';

const defaultSessionCounts = () => ({ ACTIVE: 0, PAUSED: 0, CHECKPOINTED: 0, RESTORING: 0, TERMINATED: 0 });

export async function crudRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const {
    db,
    sse,
    interrupts,
    harnessRegistry,
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
      const completedRuns = allRuns.filter((run) => run.completedAt !== null && !run.error).length;
      const failedRuns = allRuns.filter((run) => !!run.error).length;
      const recentRuns = [...allRuns]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 5);

      return {
        ...toAgentResponse(agent),
        sseClients: sse.getClientCount(agent.id),
        lastActivity: sse.getLastActivity(agent.id) ?? null,
        activeSessions: activeRuns.length,
        totalSessions: conversationCounts[idx],
        completedSessions: completedRuns,
        failedSessions: failedRuns,
        conversationCount: conversationCounts[idx],
        hasPendingInterrupt: interrupts.hasPendingForAgent(agent.id),
        sessions: recentRuns.map((turn) => toApiAgentSession(turn)),
        sessionsByStatus: sessionStatusMap.get(agent.id) ?? defaultSessionCounts(),
      };
    });

    return reply.send(await Promise.all(enriched));
  });

  app.post(
    '/',
    async (
      request: FastifyRequest<{
        Body:
          | string
          | {
            name?: string;
            harness?: string;
            harnessConfig?: Record<string, unknown>;
            systemPrompt?: string;
            tools?: string[];
            httpTools?: AgentHttpToolDefinition[];
            description?: string;
            metadata?: Record<string, unknown>;
            resourceLimits?: AgentResourceLimits | null;
            manifest?: Record<string, unknown>;
            model?: unknown;
            modelConfig?: unknown;
          };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as {
        name?: string;
        harness?: string;
        harnessConfig?: Record<string, unknown>;
        systemPrompt?: string;
        tools?: string[];
        httpTools?: AgentHttpToolDefinition[];
        description?: string;
        metadata?: Record<string, unknown>;
        resourceLimits?: AgentResourceLimits | null;
        manifest?: Record<string, unknown>;
        model?: unknown;
        modelConfig?: unknown;
      } | undefined;

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

      const validatedHarnessConfig = validateHarnessConfigInput(body.harness, body.harnessConfig, harnessRegistry);
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
          ? { manifest: body.manifest as Record<string, unknown> }
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

      if (eventBus) {
        eventBus.emit('agent.created', {
          agentId: agent.id,
          name: agent.name,
          timestamp: Date.now(),
        });
      }

      if (toolRegistry) {
        await registerAgentHttpTools(toolRegistry, agent, secretProvider);
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
        Body: {
          name?: string;
          harness?: string;
          harnessConfig?: Record<string, unknown>;
          systemPrompt?: string;
          tools?: string[];
          httpTools?: AgentHttpToolDefinition[];
          description?: string;
          metadata?: Record<string, unknown>;
          resourceLimits?: AgentResourceLimits | null;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        name?: string;
        harness?: string;
        harnessConfig?: Record<string, unknown>;
        systemPrompt?: string;
        tools?: string[];
        httpTools?: AgentHttpToolDefinition[];
        description?: string;
        metadata?: Record<string, unknown>;
        resourceLimits?: AgentResourceLimits | null;
        model?: unknown;
        modelConfig?: unknown;
      } | undefined;

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
        const validatedHarnessConfig = validateHarnessConfigInput(nextHarness, body.harnessConfig, harnessRegistry);
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
      const completedRuns = allRuns.filter((session) => session.completedAt !== null && !session.error).length;
      const failedRuns = allRuns.filter((session) => !!session.error).length;
      const recentRuns = [...allRuns]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 5);

      const sessionsByStatus = defaultSessionCounts();
      for (const session of sandboxSessions) {
        const key = session.status as keyof typeof sessionsByStatus;
        if (key in sessionsByStatus) sessionsByStatus[key]++;
      }

      return reply.send({
        ...toAgentResponse(agent),
        conversationCount: conversations.length,
        sseClients: sse.getClientCount(id),
        hasPendingInterrupt: interrupts.hasPendingForAgent(id),
        activeSessions: activeRuns.length,
        totalSessions: conversations.length,
        completedSessions: completedRuns,
        failedSessions: failedRuns,
        sessions: recentRuns.map((turn) => toApiAgentSession(turn)),
        sessionsByStatus,
      });
    },
  );
}
