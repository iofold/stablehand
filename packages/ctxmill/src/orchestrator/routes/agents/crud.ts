import { seedAgentWorkspace } from '../../../workspace/ensure.js';
import type { TurnSelect } from '../../../database/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiSandboxSessionStatusCounts } from '@ctxmill/shared';
import {
  AgentCreateInputSchema,
  AgentUpdateInputSchema,
  type AgentCreateInput,
  type AgentUpdateInput,
} from '@ctxmill/contracts';
import {
  agentManifestSchema,
  manifestToAgentCreateInput,
} from '@ctxmill/manifest';

import { getAgentHttpToolProviderName, registerAgentHttpTools } from '../../http-tools.js';
import {
  ensureAgentWorkspace,
  getRequestAgent,
  mergeToolNames,
  toAgentResponse,
  toApiAgentTurn,
  validateHarnessConfigInput,
  validateHttpTools,
  validateResourceLimits,
} from './helpers.js';
import type { AgentHttpToolDefinition, AgentSubRouteOptions, StoredAgent } from './types.js';

const RESERVED_METADATA_FIELDS = new Set([
  'httpTools',
  'mode',
  'nativeTools',
  'resourceLimits',
  'workspaceContent',
]);

function findReservedMetadataField(metadata: Record<string, unknown> | undefined): string | undefined {
  return Object.keys(metadata ?? {}).find((key) => RESERVED_METADATA_FIELDS.has(key));
}

type ManifestValidationResult =
  | { success: true; manifest: Record<string, unknown> }
  | { success: false; details: unknown };

function validateManifestSnapshot(
  manifest: unknown,
  systemPrompt: string | undefined,
  workspaceContent: AgentCreateInput['workspaceContent'] | null | undefined,
): ManifestValidationResult {
  const parsed = agentManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return { success: false, details: parsed.error.issues };
  }

  try {
    // Conversion is also the representability gate: declarations that the
    // agent API cannot apply must fail instead of being persisted and ignored.
    manifestToAgentCreateInput(parsed.data, {
      resolvedInstructions: systemPrompt
        ?? (parsed.data.spec.instructions.startsWith('file:')
          ? 'Validated file-backed instructions'
          : parsed.data.spec.instructions),
      ...(workspaceContent ? { workspaceContent } : {}),
    });
  } catch (error) {
    return {
      success: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }

  return { success: true, manifest: { ...parsed.data } };
}

const defaultSandboxSessionCounts = (): ApiSandboxSessionStatusCounts => ({
  ACTIVE: 0,
  CHECKPOINTED: 0,
  RESTORING: 0,
  TERMINATED: 0,
});

function buildAgentSummary(
  agent: StoredAgent,
  opts: {
    allTurns: TurnSelect[];
    activeTurns: TurnSelect[];
    conversationCount: number;
    sandboxSessionsByStatus: ApiSandboxSessionStatusCounts;
  },
  deps: Pick<AgentSubRouteOptions, 'sse' | 'interrupts'>,
): Record<string, unknown> {
  const completedTurns = opts.allTurns.filter((turn) => turn.completedAt !== null && !turn.error).length;
  const failedTurns = opts.allTurns.filter((turn) => !!turn.error).length;
  const recentTurns = [...opts.allTurns]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const tokensTotal = opts.allTurns.reduce((sum, turn) => sum + (turn.totalTokens ?? 0), 0);
  const tokensLast24h = opts.allTurns.reduce(
    (sum, turn) => (turn.startedAt >= dayAgo ? sum + (turn.totalTokens ?? 0) : sum),
    0,
  );

  return {
    ...toAgentResponse(agent),
    // Derived at read from open turns (ctx-1xb); the stored column is vestigial.
    status: opts.activeTurns.length > 0 ? 'running' : 'idle',
    sseClients: deps.sse.getClientCount(agent.id),
    hasPendingInterrupt: deps.interrupts.hasPendingForAgent(agent.id),
    // One counter per concept (ctx-ohq4): conversations, turns, sandbox sessions.
    conversationCount: opts.conversationCount,
    turnCount: opts.allTurns.length,
    completedTurnCount: completedTurns,
    failedTurnCount: failedTurns,
    activeTurnCount: opts.activeTurns.length,
    tokensTotal,
    tokensLast24h,
    recentTurns: recentTurns.map((turn) => toApiAgentTurn(turn)),
    sandboxSessionsByStatus: opts.sandboxSessionsByStatus,
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
      db.getSandboxSessionStatusCountsByAgent(),
    ]);

    const enriched = agentList.map(async (agent, idx) => {
      const allTurnsPromise = db.getTurnsByAgent(agent.id);
      const activeTurnsPromise = db.getActiveTurnsForAgent(agent.id);
      const [allTurns, activeTurns] = await Promise.all([allTurnsPromise, activeTurnsPromise]);

      return {
        ...buildAgentSummary(agent, {
          allTurns,
          activeTurns,
          conversationCount: conversationCounts[idx],
          sandboxSessionsByStatus: sessionStatusMap.get(agent.id) ?? defaultSandboxSessionCounts(),
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
        Body: unknown;
      }>,
      reply: FastifyReply,
    ) => {
      const parsedBody = AgentCreateInputSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'Invalid agent definition',
          details: parsedBody.error.issues,
        });
      }
      const body: AgentCreateInput = parsedBody.data;

      const reservedMetadataField = findReservedMetadataField(body.metadata);
      if (reservedMetadataField) {
        return reply.status(400).send({
          error: `metadata.${reservedMetadataField} is reserved; use the top-level ${reservedMetadataField} field`,
        });
      }

      const manifestValidation = body.manifest === undefined
        ? undefined
        : validateManifestSnapshot(body.manifest, body.systemPrompt, body.workspaceContent);
      if (manifestValidation && !manifestValidation.success) {
        return reply.status(400).send({
          error: 'Invalid canonical agent manifest',
          details: manifestValidation.details,
        });
      }

      const validatedHarnessConfig = validateHarnessConfigInput(body.harness, body.harnessConfig, harnessSchemas);
      if (!validatedHarnessConfig.success) {
        return reply.status(validatedHarnessConfig.status).send(validatedHarnessConfig.body);
      }

      if (body.resourceLimits) {
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
      if (body.nativeTools) {
        metadata.nativeTools = body.nativeTools;
      }
      if (body.workspaceContent) {
        metadata.workspaceContent = body.workspaceContent;
      }
      if (body.mode) {
        metadata.mode = body.mode;
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
        ...(manifestValidation?.success
          ? { manifest: manifestValidation.manifest }
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
        Body: unknown;
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const parsedBody = AgentUpdateInputSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'Invalid agent update',
          details: parsedBody.error.issues,
        });
      }
      const body: AgentUpdateInput = parsedBody.data;

      const reservedMetadataField = findReservedMetadataField(body.metadata);
      if (reservedMetadataField) {
        return reply.status(400).send({
          error: `metadata.${reservedMetadataField} is reserved; use the top-level ${reservedMetadataField} field`,
        });
      }

      const manifestValidation = body.manifest === undefined || body.manifest === null
        ? undefined
        : validateManifestSnapshot(body.manifest, body.systemPrompt, body.workspaceContent);
      if (manifestValidation && !manifestValidation.success) {
        return reply.status(400).send({
          error: 'Invalid canonical agent manifest',
          details: manifestValidation.details,
        });
      }

      if (body.resourceLimits) {
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

      const updateData: Parameters<typeof db.updateAgent>[1] = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.systemPrompt !== undefined) updateData.systemPrompt = body.systemPrompt;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.manifest === null) {
        updateData.manifest = null;
      } else if (manifestValidation?.success) {
        updateData.manifest = manifestValidation.manifest;
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

      if (
        body.resourceLimits !== undefined
        || body.metadata !== undefined
        || body.httpTools !== undefined
        || body.nativeTools !== undefined
        || body.workspaceContent !== undefined
        || body.mode !== undefined
      ) {
        const newMetadata = { ...existingMetadata, ...(body.metadata ?? {}) };

        if (body.httpTools === undefined && existingMetadata.httpTools !== undefined) {
          newMetadata.httpTools = existingMetadata.httpTools;
        }

        if (body.resourceLimits === null) {
          delete newMetadata.resourceLimits;
        } else if (body.resourceLimits) {
          newMetadata.resourceLimits = body.resourceLimits;
        }

        if (body.nativeTools === null) {
          delete newMetadata.nativeTools;
        } else if (body.nativeTools) {
          newMetadata.nativeTools = body.nativeTools;
        }

        if (body.workspaceContent === null) {
          delete newMetadata.workspaceContent;
        } else if (body.workspaceContent) {
          newMetadata.workspaceContent = body.workspaceContent;
        }

        if (body.mode === null) {
          delete newMetadata.mode;
        } else if (body.mode) {
          newMetadata.mode = body.mode;
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

      const [conversations, allTurns, activeTurns, sandboxSessions] = await Promise.all([
        db.getConversationsForAgent(id),
        db.getTurnsByAgent(id),
        db.getActiveTurnsForAgent(id),
        db.getSandboxSessionsByAgent(id),
      ]);
      const sandboxSessionsByStatus = defaultSandboxSessionCounts();
      for (const session of sandboxSessions) {
        const key = session.status as keyof typeof sandboxSessionsByStatus;
        if (key in sandboxSessionsByStatus) sandboxSessionsByStatus[key]++;
      }

      return reply.send(buildAgentSummary(agent, {
        allTurns,
        activeTurns,
        conversationCount: conversations.length,
        sandboxSessionsByStatus,
      }, { sse, interrupts }));
    },
  );
}
