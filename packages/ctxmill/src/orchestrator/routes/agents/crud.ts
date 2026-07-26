import { rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { seedAgentWorkspace } from '../../../workspace/ensure.js';
import type { TurnSelect } from '../../../database/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiSandboxSessionStatusCounts } from '@ctxmill/shared';
import {
  AgentCreateInputSchema,
  AgentPatchInputSchema,
  type AgentCreateInput,
  type AgentPatchInput,
} from '@ctxmill/contracts';
import {
  agentManifestSchema,
  manifestToAgentCreateInput,
  type AgentManifest,
} from '@ctxmill/manifest';

import { getAgentHttpToolProviderName, registerAgentHttpTools } from '../../http-tools.js';
import {
  AGENT_MANAGED_METADATA_FIELDS,
  ensureAgentWorkspace,
  getAgentHttpTools,
  getRequestAgent,
  toAgentResponse,
  validateHarnessConfigInput,
  validateHttpTools,
  validateResourceLimits,
} from './helpers.js';
import type { AgentHttpToolDefinition, AgentSubRouteOptions, StoredAgent } from './types.js';
import { isUniqueConstraintViolation } from '../../../database/errors.js';

const AGENT_NAME_UNIQUE_CONSTRAINT = 'idx_agents_name';

function agentNameConflict(name: string) {
  return {
    error: `Agent name "${name}" is already in use`,
    code: 'agent_name_conflict',
    name,
  };
}

function agentPersistenceSnapshot(agent: StoredAgent) {
  return {
    name: agent.name,
    harness: agent.harness,
    harnessConfig: agent.harnessConfig,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    description: agent.description,
    workspaceDir: agent.workspaceDir,
    manifest: agent.manifest,
    metadata: agent.metadata,
  };
}

function findReservedMetadataField(metadata: Record<string, unknown> | null | undefined): string | undefined {
  return Object.keys(metadata ?? {}).find((key) => AGENT_MANAGED_METADATA_FIELDS.has(key));
}

function findHttpToolNameCollision(
  tools: readonly string[],
  httpTools: readonly AgentHttpToolDefinition[] | undefined,
): string | undefined {
  const toolNames = new Set(tools);
  return httpTools?.find((tool) => toolNames.has(tool.name))?.name;
}

type ManifestValidationResult =
  | {
    success: true;
    manifest: Record<string, unknown>;
    compiled: AgentCreateInput;
  }
  | { success: false; details: unknown };

const MANIFEST_OWNED_FIELDS = [
  'name',
  'harness',
  'harnessConfig',
  'systemPrompt',
  'tools',
  'description',
  'metadata',
  'resourceLimits',
  'builtinToolPolicy',
  'nativeToolPolicy',
  'workspaceContent',
  'mode',
] as const;

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
    const validatedManifest = parsed.data as AgentManifest;
    // Conversion is also the representability gate: declarations that the
    // agent API cannot apply must fail instead of being persisted and ignored.
    const usesFileBackedInstructions = validatedManifest.spec.instructions.startsWith('file:');
    if (usesFileBackedInstructions && systemPrompt === undefined) {
      return {
        success: false,
        details: 'File-backed manifest instructions require the resolved systemPrompt',
      };
    }
    const compiled = manifestToAgentCreateInput(validatedManifest, {
      ...(usesFileBackedInstructions ? { resolvedInstructions: systemPrompt } : {}),
      ...(workspaceContent ? { workspaceContent } : {}),
    });
    return {
      success: true,
      manifest: { ...validatedManifest },
      compiled,
    };
  } catch (error) {
    return {
      success: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

function manifestDefinitionConflicts(
  input: AgentCreateInput | AgentPatchInput,
  compiled: AgentCreateInput,
): string[] {
  const inputRecord = input as Record<string, unknown>;
  const compiledRecord = compiled as Record<string, unknown>;
  return MANIFEST_OWNED_FIELDS.filter((field) => {
    if (inputRecord[field] === undefined) return false;
    const expected = field === 'description'
      ? compiledRecord[field] ?? null
      : compiledRecord[field];
    return !isDeepStrictEqual(inputRecord[field], expected);
  });
}

function hasManifestOwnedPatch(input: AgentPatchInput): boolean {
  const inputRecord = input as Record<string, unknown>;
  return MANIFEST_OWNED_FIELDS.some((field) => inputRecord[field] !== undefined);
}

function manifestCompiledPatch(
  input: AgentPatchInput,
  compiled: AgentCreateInput,
): AgentPatchInput {
  return {
    ...input,
    name: compiled.name,
    harness: compiled.harness,
    harnessConfig: compiled.harnessConfig,
    systemPrompt: compiled.systemPrompt,
    tools: compiled.tools,
    description: compiled.description ?? null,
    metadata: compiled.metadata ?? null,
    resourceLimits: compiled.resourceLimits ?? null,
    builtinToolPolicy: compiled.builtinToolPolicy ?? null,
    nativeToolPolicy: compiled.nativeToolPolicy ?? null,
    workspaceContent: compiled.workspaceContent ?? null,
    mode: compiled.mode ?? null,
  };
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
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const tokensTotal = opts.allTurns.reduce((sum, turn) => sum + (turn.totalTokens ?? 0), 0);
  const tokensLast24h = opts.allTurns.reduce(
    (sum, turn) => (turn.startedAt >= dayAgo ? sum + (turn.totalTokens ?? 0) : sum),
    0,
  );

  return {
    ...toAgentResponse(agent),
    // Derived at read from open turns (ctx-1xb).
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
    canonicalLog,
    scheduleService,
    triggerManager,
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
      if (manifestValidation?.success) {
        const conflicts = manifestDefinitionConflicts(body, manifestValidation.compiled);
        if (conflicts.length > 0) {
          return reply.status(400).send({
            error: 'Agent definition conflicts with canonical manifest',
            details: conflicts,
          });
        }
      }
      const manifestCompiled = manifestValidation?.success
        ? manifestValidation.compiled
        : undefined;
      const definition = manifestCompiled ?? body;

      const validatedHarnessConfig = validateHarnessConfigInput(
        definition.harness,
        definition.harnessConfig,
        harnessSchemas,
      );
      if (!validatedHarnessConfig.success) {
        return reply.status(validatedHarnessConfig.status).send(validatedHarnessConfig.body);
      }

      if (definition.resourceLimits) {
        const limitsErrors = validateResourceLimits(definition.resourceLimits as Record<string, unknown>);
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

      const httpToolNameCollision = findHttpToolNameCollision(definition.tools, httpToolDefs);
      if (httpToolNameCollision) {
        return reply.status(400).send({
          error: `Tool reference "${httpToolNameCollision}" cannot also be an HTTP tool`,
        });
      }

      const metadata: Record<string, unknown> = { ...(definition.metadata ?? {}) };
      if (definition.resourceLimits) {
        metadata.resourceLimits = definition.resourceLimits;
      }
      if (definition.builtinToolPolicy) {
        metadata.builtinToolPolicy = definition.builtinToolPolicy;
      }
      if (definition.nativeToolPolicy) {
        metadata.nativeToolPolicy = definition.nativeToolPolicy;
      }
      if (definition.workspaceContent) {
        metadata.workspaceContent = definition.workspaceContent;
      }
      if (definition.mode) {
        metadata.mode = definition.mode;
      }
      if (httpToolDefs !== undefined) {
        metadata.httpTools = httpToolDefs;
      }

      let agent: StoredAgent;
      try {
        agent = await db.createAgent({
          name: definition.name,
          harness: definition.harness,
          harnessConfig: JSON.stringify(validatedHarnessConfig.harnessConfig),
          systemPrompt: definition.systemPrompt,
          tools: definition.tools,
          description: definition.description ?? null,
          metadata: Object.keys(metadata).length > 0 ? metadata : null,
          ...(manifestValidation?.success
            ? { manifest: manifestValidation.manifest }
            : {}),
        });
      } catch (error) {
        if (isUniqueConstraintViolation(error, AGENT_NAME_UNIQUE_CONSTRAINT)) {
          return reply.status(409).send(agentNameConflict(body.name));
        }
        throw error;
      }

      const workspaceDir = ensureAgentWorkspace(agent.id, { dataDir });
      if (workspaceDir) {
        seedAgentWorkspace(workspaceDir);
        if (!agent.workspaceDir) {
          await db.updateAgent(agent.id, { workspaceDir });
          agent = { ...agent, workspaceDir };
        }
      }

      if (toolRegistry) {
        try {
          await registerAgentHttpTools(toolRegistry, agent, secretProvider);
        } catch (registrationError) {
          toolRegistry.removeProvider(getAgentHttpToolProviderName(agent.id));
          try {
            await db.deleteAgentCascade(agent.id);
            if (agent.workspaceDir) {
              await rm(agent.workspaceDir, { recursive: true, force: true });
            }
          } catch (rollbackError) {
            throw new AggregateError(
              [registrationError, rollbackError],
              `HTTP tool registration and agent creation rollback both failed for ${agent.id}`,
              { cause: rollbackError },
            );
          }
          throw registrationError;
        }
      }

      if (eventBus) {
        eventBus.emit('agent.created', {
          agentId: agent.id,
          name: agent.name,
          timestamp: Date.now(),
        });
      }

      return reply.status(201).send({ ...toAgentResponse(agent), status: 'idle' });
    },
  );

  app.patch(
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
      const parsedBody = AgentPatchInputSchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'Invalid agent update',
          details: parsedBody.error.issues,
        });
      }
      const body: AgentPatchInput = parsedBody.data;

      const agent = getRequestAgent(request);
      if (
        agent.manifest
        && body.manifest === undefined
        && hasManifestOwnedPatch(body)
      ) {
        return reply.status(400).send({
          error: 'Manifest-backed agents must be edited through manifest',
        });
      }

      const reservedMetadataField = findReservedMetadataField(body.metadata);
      if (reservedMetadataField) {
        return reply.status(400).send({
          error: `metadata.${reservedMetadataField} is reserved; use the top-level ${reservedMetadataField} field`,
        });
      }

      const manifestValidation = body.manifest === undefined || body.manifest === null
        ? undefined
        : validateManifestSnapshot(
          body.manifest,
          body.systemPrompt ?? agent.systemPrompt,
          body.workspaceContent,
        );
      if (manifestValidation && !manifestValidation.success) {
        return reply.status(400).send({
          error: 'Invalid canonical agent manifest',
          details: manifestValidation.details,
        });
      }
      if (manifestValidation?.success) {
        const conflicts = manifestDefinitionConflicts(body, manifestValidation.compiled);
        if (conflicts.length > 0) {
          return reply.status(400).send({
            error: 'Agent definition conflicts with canonical manifest',
            details: conflicts,
          });
        }
      }

      const update = manifestValidation?.success
        ? manifestCompiledPatch(body, manifestValidation.compiled)
        : body;

      if (update.resourceLimits) {
        const limitsErrors = validateResourceLimits(update.resourceLimits as Record<string, unknown>);
        if (limitsErrors.length > 0) {
          return reply.status(400).send({
            error: 'Invalid resource limits',
            details: limitsErrors,
          });
        }
      }

      const existingMetadata = (agent.metadata ?? {}) as Record<string, unknown>;
      const existingHttpTools = getAgentHttpTools(existingMetadata);

      const httpToolError = validateHttpTools(update.httpTools);
      if (httpToolError) {
        return reply.status(400).send({ error: httpToolError });
      }


      const nextBaseTools = update.tools ?? agent.tools;
      const nextHttpTools = update.httpTools ?? existingHttpTools;
      const httpToolNameCollision = findHttpToolNameCollision(nextBaseTools, nextHttpTools);
      if (httpToolNameCollision) {
        return reply.status(400).send({
          error: `Tool reference "${httpToolNameCollision}" cannot also be an HTTP tool`,
        });
      }

      const updateData: Parameters<typeof db.updateAgent>[1] = {};
      if (update.name !== undefined) updateData.name = update.name;
      if (update.systemPrompt !== undefined) updateData.systemPrompt = update.systemPrompt;
      if (update.description !== undefined) updateData.description = update.description;
      if (update.manifest === null) {
        updateData.manifest = null;
      } else if (manifestValidation?.success) {
        updateData.manifest = manifestValidation.manifest;
      }

      if (update.harness !== undefined && update.harnessConfig === undefined) {
        return reply.status(400).send({ error: 'harnessConfig is required when changing harness' });
      }

      const nextHarness = update.harness ?? agent.harness;
      if (update.harnessConfig !== undefined) {
        const validatedHarnessConfig = validateHarnessConfigInput(nextHarness, update.harnessConfig, harnessSchemas);
        if (!validatedHarnessConfig.success) {
          return reply.status(validatedHarnessConfig.status).send(validatedHarnessConfig.body);
        }

        updateData.harnessConfig = JSON.stringify(validatedHarnessConfig.harnessConfig);
      }

      if (update.harness !== undefined) {
        updateData.harness = update.harness;
      }

      if (update.tools !== undefined) updateData.tools = update.tools;

      if (
        update.resourceLimits !== undefined
        || update.builtinToolPolicy !== undefined
        || update.metadata !== undefined
        || update.httpTools !== undefined
        || update.nativeToolPolicy !== undefined
        || update.workspaceContent !== undefined
        || update.mode !== undefined
        || update.manifest !== undefined
      ) {
        const existingManagedMetadata = Object.fromEntries(
          Object.entries(existingMetadata).filter(([key]) => AGENT_MANAGED_METADATA_FIELDS.has(key)),
        );
        const newMetadata = update.metadata !== undefined
          ? { ...(update.metadata ?? {}), ...existingManagedMetadata }
          : { ...existingMetadata };

        // A replaced manifest is a complete declarative snapshot. Remove the
        // prior compiled overrides first so omitted values are truly removed
        // and the new manifest becomes the fallback source of truth.
        if (update.manifest !== undefined) {
          delete newMetadata.builtinToolPolicy;
          delete newMetadata.nativeToolPolicy;
          delete newMetadata.resourceLimits;
          delete newMetadata.workspaceContent;
          delete newMetadata.mode;
        }

        if (update.httpTools === undefined && existingMetadata.httpTools !== undefined) {
          newMetadata.httpTools = existingMetadata.httpTools;
        }

        if (update.resourceLimits === null) {
          delete newMetadata.resourceLimits;
        } else if (update.resourceLimits) {
          newMetadata.resourceLimits = update.resourceLimits;
        }

        if (update.builtinToolPolicy === null) {
          delete newMetadata.builtinToolPolicy;
        } else if (update.builtinToolPolicy) {
          newMetadata.builtinToolPolicy = update.builtinToolPolicy;
        }

        if (update.nativeToolPolicy === null) {
          delete newMetadata.nativeToolPolicy;
        } else if (update.nativeToolPolicy) {
          newMetadata.nativeToolPolicy = update.nativeToolPolicy;
        }

        if (update.workspaceContent === null) {
          delete newMetadata.workspaceContent;
        } else if (update.workspaceContent) {
          newMetadata.workspaceContent = update.workspaceContent;
        }

        if (update.mode === null) {
          delete newMetadata.mode;
        } else if (update.mode) {
          newMetadata.mode = update.mode;
        }

        if (update.httpTools !== undefined) {
          newMetadata.httpTools = update.httpTools;
        }

        updateData.metadata = Object.keys(newMetadata).length > 0 ? newMetadata : null;
      }

      let updated: StoredAgent | undefined;
      try {
        updated = await db.updateAgent(id, updateData);
      } catch (error) {
        if (
          update.name !== undefined
          && isUniqueConstraintViolation(error, AGENT_NAME_UNIQUE_CONSTRAINT)
        ) {
          return reply.status(409).send(agentNameConflict(update.name));
        }
        throw error;
      }

      if (updated && toolRegistry) {
        try {
          await registerAgentHttpTools(toolRegistry, updated, secretProvider);
        } catch (registrationError) {
          try {
            const restored = await db.updateAgent(id, agentPersistenceSnapshot(agent));
            if (!restored) {
              throw new Error(
                `Agent ${id} disappeared while rolling back its HTTP tool update`,
                { cause: registrationError },
              );
            }
            await registerAgentHttpTools(toolRegistry, restored, secretProvider);
          } catch (rollbackError) {
            throw new AggregateError(
              [registrationError, rollbackError],
              `HTTP tool registration and agent update rollback both failed for ${id}`,
              { cause: rollbackError },
            );
          }
          throw registrationError;
        }
      }

      const activeTurns = updated ? await db.getActiveTurnsForAgent(id) : [];
      return reply.send(updated
        ? { ...toAgentResponse(updated), status: activeTurns.length > 0 ? 'running' : 'idle' }
        : updated);
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
      // Fail closed at the first deletion boundary: fence new schedule and
      // trigger dispatch while the remaining agent-owned runtime is torn down.
      const triggerDrain = triggerManager?.stopForAgent(id);
      const scheduleDrain = scheduleService?.stopForAgent(id);
      await Promise.all([triggerDrain, scheduleDrain]);
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

      // Stop prior local canonical writes before purging the agent's history.
      // The delete event is intentionally persisted afterwards as the sole
      // retained lifecycle tombstone for this hard-deleted agent.
      await canonicalLog?.drain();
      await db.deleteAgentCascade(id);

      if (eventBus) {
        await eventBus.emitAsync('agent.deleted', {
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
