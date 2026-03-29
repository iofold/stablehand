import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, normalize, join, dirname } from 'node:path';
import { readdir, stat, readFile, writeFile, unlink, mkdir, mkdtemp, rename, rm, chown } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SSEManager } from '../sse.js';
import type { InterruptManager } from '../interrupt.js';
import type { RunRegistry } from '../run-registry.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { AgentDefinition, AgentResourceLimits } from '../../types.js';
import type { HarnessRegistry } from '../../harness/types.js';
import type { LearningPipeline } from '../../learning/types.js';
import type { KnowledgeStore } from '../../knowledge/types.js';
import type { AgentRunService } from '../agent-run-service.js';
import type { SandboxSessionManager } from '../sandbox-run-service.js';
import type { TypedEventBus } from '../../events/bus.js';
import { TraceCollector } from '../../learning/trace.js';
import { ensureAgentWorkspace as ensureAgentWorkspaceShared, seedAgentWorkspace } from '../../workspace/ensure.js';
import { validateAndExtractTarball } from '../../workspace/tar-upload.js';
import { getErrorMessage } from '../../util/errors.js';
import type { SecretProvider } from '../../secrets/types.js';
import type { SystemSettingsService } from '../../settings/service.js';
import type { HttpAuthConfig, HttpEndpointConfig } from '../../tool/providers/http.js';
import { DefaultToolRegistry } from '../../tool/registry.js';
import {
  discoverSkills,
  loadSkill,
  createSkillDirectory,
  updateSkillMd,
  isValidSkillName,
} from '../../skills/loader.js';
import type { LoadedSkill } from '@ctxmill/shared';
import {
  isBlockedPath,
  resolveBaseDir,
  validateSandboxPath,
  mapMessagesToInternal,
  requireAgent,
} from './agent-helpers.js';
import { getAgentHttpToolProviderName, registerAgentHttpTools } from '../http-tools.js';

/** Build a safe error response — only include details in development mode. */
function safeError(message: string, err: unknown): { error: string; detail?: string } {
  console.error(`[agents] endpoint error:`, err);
  if (process.env.NODE_ENV === 'development') {
    return { error: message, detail: String(err) };
  }
  return { error: 'Internal error' };
}

async function chownRecursive(dir: string, uid: number, gid: number): Promise<void> {
  try {
    await chown(dir, uid, gid);
    const entries = await readdir(dir);
    for (const name of entries) {
      const fullPath = join(dir, name);
      const s = await stat(fullPath);
      await chown(fullPath, uid, gid);
      if (s.isDirectory()) {
        await chownRecursive(fullPath, uid, gid);
      }
    }
  } catch {
    /* non-root process — skip chown */
  }
}

/**
 * Validate resource limits for an agent.
 * Returns an array of validation error strings. Empty array means valid.
 */
function validateResourceLimits(limits: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (limits.cpus !== undefined) {
    const cpus = Number(limits.cpus);
    if (isNaN(cpus) || cpus < 0.5 || cpus > 4.0) {
      errors.push(`cpus must be between 0.5 and 4.0, got ${limits.cpus}`);
    }
  }

  if (limits.memoryMb !== undefined) {
    const mem = Number(limits.memoryMb);
    if (isNaN(mem) || !Number.isInteger(mem) || mem < 256 || mem > 4096) {
      errors.push(`memoryMb must be an integer between 256 and 4096, got ${limits.memoryMb}`);
    }
  }

  if (limits.pidsLimit !== undefined) {
    const pids = Number(limits.pidsLimit);
    if (isNaN(pids) || !Number.isInteger(pids) || pids < 64 || pids > 512) {
      errors.push(`pidsLimit must be an integer between 64 and 512, got ${limits.pidsLimit}`);
    }
  }

  if (limits.timeoutSec !== undefined) {
    const timeout = Number(limits.timeoutSec);
    if (isNaN(timeout) || !Number.isInteger(timeout) || timeout < 60 || timeout > 3600) {
      errors.push(`timeoutSec must be an integer between 60 and 3600, got ${limits.timeoutSec}`);
    }
  }

  return errors;
}

type AgentHttpToolDefinition = {
  name: string;
  description: string;
  endpoint: string;
  method?: HttpEndpointConfig['method'];
  inputSchema?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
  authentication?: HttpAuthConfig;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getHttpToolNames(httpTools?: AgentHttpToolDefinition[] | unknown): string[] {
  if (!Array.isArray(httpTools) || httpTools.length === 0) return [];
  return httpTools
    .filter((tool): tool is AgentHttpToolDefinition => isObjectRecord(tool) && isNonEmptyString(tool.name))
    .map((tool) => tool.name);
}

function validateHttpTools(httpTools?: AgentHttpToolDefinition[] | unknown): string | null {
  if (httpTools === undefined) return null;
  if (!Array.isArray(httpTools)) {
    return 'HTTP tool requires name, description, and endpoint';
  }
  for (const httpTool of httpTools) {
    if (
      !isObjectRecord(httpTool) ||
      !isNonEmptyString(httpTool.name) ||
      !isNonEmptyString(httpTool.description) ||
      !isNonEmptyString(httpTool.endpoint)
    ) {
      return 'HTTP tool requires name, description, and endpoint';
    }
  }
  return null;
}

function mergeToolNames(
  baseTools: string[],
  httpTools?: AgentHttpToolDefinition[] | unknown,
): string[] {
  return [...new Set([...baseTools, ...getHttpToolNames(httpTools)])];
}

function parseStoredHarnessConfig(harnessConfigJson: string): Record<string, unknown> {
  const parsed = JSON.parse(harnessConfigJson) as unknown;
  if (!isObjectRecord(parsed)) {
    throw new Error('Stored harnessConfig must be a JSON object');
  }
  return parsed;
}

type StoredAgent = NonNullable<Awaited<ReturnType<DatabaseRepository['getAgent']>>>;

/** Convert a DB agent row to an AgentDefinition for the sandbox runner. */
function toAgentDef(agent: StoredAgent): AgentDefinition {
  const manifest = agent.manifest ?? null;
  const manifestSpec = (manifest as Record<string, unknown> | null)?.spec as Record<string, unknown> | undefined;
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;
  const resourceLimits = (manifest?.resourceLimits ?? manifestSpec?.resources ?? meta.resourceLimits) as AgentResourceLimits | undefined;

  const rawNativeTools = ('nativeTools' in meta ? meta.nativeTools : manifestSpec?.nativeTools) as
    { allowlist?: string[]; blocklist?: string[] } | undefined;
  const rawWorkspaceContent = (manifestSpec?.workspace as Record<string, unknown> | undefined)?.content as
    { files?: Array<{ src: string; dest: string }>; skills?: boolean | string[] } | undefined;

  return {
    name: agent.name,
    harness: agent.harness,
    harnessConfig: parseStoredHarnessConfig(agent.harnessConfig),
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    description: agent.description ?? undefined,
    metadata: agent.metadata ?? undefined,
    workspaceDir: agent.workspaceDir ?? undefined,
    resourceLimits,
    ...(rawNativeTools ? { nativeTools: rawNativeTools } : {}),
    ...(rawWorkspaceContent ? { workspaceContent: rawWorkspaceContent } : {}),
  };
}

/** Shared application context injected via plugin options. */
export interface AgentRouteOptions {
  db: DatabaseRepository;
  sse: SSEManager;
  interrupts: InterruptManager;
  runRegistry: RunRegistry;
  harnessRegistry: HarnessRegistry;
  learningPipeline?: LearningPipeline;
  knowledgeStore?: KnowledgeStore;
  agentRunService: AgentRunService;
  eventBus?: TypedEventBus;
  /** Path to the .ctxmill data directory for agent workspaces. */
  dataDir?: string;
  secretProvider?: SecretProvider;
  toolRegistry?: DefaultToolRegistry;
  sandboxSessionManager?: SandboxSessionManager;
  settingsService?: SystemSettingsService;
}

export async function agentRoutes(
  app: FastifyInstance,
  opts: AgentRouteOptions,
): Promise<void> {
  const { db, sse, interrupts, runRegistry, harnessRegistry, learningPipeline, knowledgeStore, agentRunService, eventBus, dataDir, secretProvider, toolRegistry, sandboxSessionManager, settingsService } = opts;
  const validWebhookEvents = ['run.started', 'run.completed', 'run.tool_started', 'run.tool_result', 'run.interrupted', 'run.interrupt_resolved'];

  // Pre-handler that loads the agent by :id and attaches it to the request.
  // Routes using this hook can access the agent via `getRequestAgent(request)`.
  const loadAgent = requireAgent(db);

  /** Retrieve the agent attached by the `loadAgent` preHandler. */
  function getRequestAgent(request: FastifyRequest): NonNullable<Awaited<ReturnType<typeof db.getAgent>>> {
    return (request as any).agent;
  }

  /**
   * Create workspace/skills/notes directories for an agent under base/ and return the workspace path.
   * Delegates to the shared ensureAgentWorkspace from workspace/ensure.ts.
   */
  function ensureAgentWorkspace(agentId: string): string | undefined {
    if (!dataDir) return undefined;
    return ensureAgentWorkspaceShared(dataDir, agentId);
  }

  function extractManifestFields(agent: { manifest?: Record<string, unknown> | null; metadata?: Record<string, unknown> | null }) {
    const spec = (agent.manifest as Record<string, unknown> | null)?.spec as Record<string, unknown> | undefined;
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    return {
      nativeTools: ('nativeTools' in meta ? meta.nativeTools : spec?.nativeTools ?? null) as Record<string, unknown> | null,
      workspaceContent: ((spec?.workspace as Record<string, unknown> | undefined)?.content ?? null) as Record<string, unknown> | null,
    };
  }

  function toAgentResponse(agent: StoredAgent): Record<string, unknown> {
    const agentMeta = (agent.metadata ?? {}) as Record<string, unknown>;
    return {
      ...agent,
      harnessConfig: parseStoredHarnessConfig(agent.harnessConfig),
      ...extractManifestFields(agent),
      resourceLimits: agentMeta.resourceLimits ?? null,
    };
  }

  function getHarnessError(harnessName: string): string {
    const available = harnessRegistry.list();
    if (available.length === 0) {
      return `Unknown harness: ${harnessName}`;
    }

    return `Unknown harness: ${harnessName}. Available: ${available.join(', ')}`;
  }

  function validateHarnessConfigInput(
    harnessName: string,
    harnessConfig: unknown,
  ):
    | { success: true; harnessConfig: Record<string, unknown> }
    | { success: false; status: number; body: Record<string, unknown> } {
    if (!isObjectRecord(harnessConfig)) {
      return {
        success: false,
        status: 400,
        body: {
          error: `Invalid harnessConfig for harness "${harnessName}"`,
          details: [{ message: 'harnessConfig must be an object' }],
        },
      };
    }

    let harness: ReturnType<HarnessRegistry['get']>;
    try {
      harness = harnessRegistry.get(harnessName);
    } catch {
      return {
        success: false,
        status: 400,
        body: { error: getHarnessError(harnessName) },
      };
    }

    const parseResult = harness.configSchema.safeParse(harnessConfig);
    if (!parseResult.success) {
      return {
        success: false,
        status: 400,
        body: {
          error: `Invalid harnessConfig for harness "${harnessName}"`,
          details: parseResult.error.issues,
        },
      };
    }

    return {
      success: true,
      harnessConfig: parseResult.data as Record<string, unknown>,
    };
  }

  // ── GET /api/agents — List all agents ──────────────────

  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const agentList = await db.listAgents();
    const [conversationCounts, sessionStatusMap] = await Promise.all([
      Promise.all(agentList.map((agent) => db.getConversationCount(agent.id))),
      db.getSessionStatusCountsByAgent(),
    ]);

    const defaultSessionCounts = { active: 0, frozen: 0, checkpointed: 0, terminated: 0 };

    const enriched = agentList.map((agent, idx) => {
      const allSessions = runRegistry.getAllRuns(agent.id);
      const activeSessions = runRegistry.getActiveRuns(agent.id);
      const completedSessions = allSessions.filter((r) => r.status === 'completed').length;
      const failedSessions = allSessions.filter((r) => r.status === 'error').length;
      const recentSessions = [...allSessions]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 5);

      return {
        ...toAgentResponse(agent),
        sseClients: sse.getClientCount(agent.id),
        lastActivity: sse.getLastActivity(agent.id) ?? null,
        activeSessions: activeSessions.length,
        totalSessions: allSessions.length,
        completedSessions,
        failedSessions,
        conversationCount: conversationCounts[idx],
        hasPendingInterrupt: interrupts.hasPendingForAgent(agent.id),
        sessions: recentSessions,
        sessionsByStatus: sessionStatusMap.get(agent.id) ?? defaultSessionCounts,
      };
    });
    return reply.send(enriched);
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

      const validatedHarnessConfig = validateHarnessConfigInput(body.harness, body.harnessConfig);
      if (!validatedHarnessConfig.success) {
        return reply.status(validatedHarnessConfig.status).send(validatedHarnessConfig.body);
      }

      // Validate resource limits if provided
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

      // Merge resourceLimits into metadata for DB storage
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
      });

      // Create workspace directories and update the agent record
      const workspaceDir = ensureAgentWorkspace(agent.id);
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

  // ── PUT /api/agents/:id — Update an agent ──────────────

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

      // Validate resource limits if provided
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
      const existingHttpToolNames = new Set(getHttpToolNames(existingHttpTools));

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
        const validatedHarnessConfig = validateHarnessConfigInput(nextHarness, body.harnessConfig);
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

      // Merge resourceLimits into metadata for DB storage
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

  // ── DELETE /api/agents/:id — Delete an agent ───────────

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

  // ── GET /api/agents/:id — Get agent detail ─────────────

  app.get(
    '/:id',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const agent = getRequestAgent(request);

      const conversations = await db.getConversationsForAgent(id);
      return reply.send({
        ...toAgentResponse(agent),
        conversationCount: conversations.length,
        sseClients: sse.getClientCount(id),
        hasPendingInterrupt: interrupts.hasPendingForAgent(id),
      });
    },
  );

  // ── POST /api/agents/:id/message — Send message to agent ─

  app.post(
    '/:id/message',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { content: string; conversationId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { content: string; conversationId?: string };

      if (!body || typeof body.content !== 'string' || body.content.trim() === '') {
        return reply.status(400).send({ error: 'content is required and must be a non-empty string' });
      }

      const agent = getRequestAgent(request);

      // Get or create conversation
      let conversationId = body.conversationId;
      if (!conversationId) {
        const conv = await db.createConversation(id);
        conversationId = conv.id;
      }

      // Create user message
      const message = await db.addMessage({
        agentId: id,
        conversationId,
        role: 'user',
        content: body.content,
      });

      // Create an interactive run in the registry + DB
      const run = await runRegistry.startRun(id, conversationId, 'interactive');

      // Broadcast a user message event via SSE
      sse.broadcast(id, {
        type: 'TEXT_MESSAGE_START',
        timestamp: Date.now(),
        runId: conversationId,
        messageId: message.id,
        role: 'user',
      });
      sse.broadcast(id, {
        type: 'TEXT_MESSAGE_CONTENT',
        timestamp: Date.now(),
        runId: conversationId,
        messageId: message.id,
        content: body.content,
      });
      sse.broadcast(id, {
        type: 'TEXT_MESSAGE_END',
        timestamp: Date.now(),
        runId: conversationId,
        messageId: message.id,
      });

      // Spawn the agent run asynchronously — don't block the response.
      // DB is the single source of truth for agent definitions.
      if (!agent.harness) {
        return reply.status(500).send({ error: 'Agent harness is not set' });
      }
      const agentDef = toAgentDef(agent);
      const allMessages = await db.getMessages(conversationId);
      const messages = mapMessagesToInternal(allMessages, id);

      // Delegate to AgentRunService (fire-and-forget)
      void agentRunService.executeRun({
        agentDef,
        messages,
        agentId: id,
        conversationId,
        runId: run.id,
        taskDescription: body.content,
      }).catch((err) => {
        console.error(`[agents] executeRun failed for agent ${id}, run ${run.id}:`, err);
      });

      return reply.status(201).send({
        messageId: message.id,
        conversationId,
        runId: run.id,
      });
    },
  );

  // ── POST /api/agents/:id/run — Start a background agent run ─

  app.post(
    '/:id/run',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { task: string; mode?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { task?: string; mode?: string } | undefined;

      if (!body || typeof body.task !== 'string' || body.task.trim() === '') {
        return reply.status(400).send({ error: 'task is required and must be a non-empty string' });
      }

      const agent = getRequestAgent(request);

      // Create a conversation for this background run
      const conv = await db.createConversation(id);
      const conversationId = conv.id;

      // Create a run in the registry + DB
      const run = await runRegistry.startRun(id, conversationId, 'background', body.task);

      // Update agent status to 'running'
      await db.updateAgentStatus(id, 'running');

      // Broadcast RUN_STARTED via SSE
      sse.broadcast(id, {
        type: 'RUN_STARTED',
        timestamp: Date.now(),
        runId: run.id,
        mode: 'background',
        taskDescription: body.task,
      });

      // Fire-and-forget: run the agent with the task as a synthetic user message
      // DB is the single source of truth for agent definitions.
      if (!agent.harness) {
        return reply.status(500).send({ error: 'Agent harness is not set' });
      }
      const agentDef = toAgentDef(agent);

      // Create a synthetic user message from the task
      await db.addMessage({
        agentId: id,
        conversationId,
        role: 'user',
        content: body.task,
      });

      const allMessages = await db.getMessages(conversationId);
      const messages = mapMessagesToInternal(allMessages, id);

      // Delegate to AgentRunService (fire-and-forget)
      void agentRunService.executeRun({
        agentDef,
        messages,
        agentId: id,
        conversationId,
        runId: run.id,
        taskDescription: body.task ?? 'background run',
      }).catch((err) => {
        console.error(`[agents] executeRun failed for agent ${id}, run ${run.id}:`, err);
      });

      return reply.status(201).send({
        runId: run.id,
        conversationId,
      });
    },
  );

  app.post(
    '/:id/sessions/:runId/cancel',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string; runId: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const run = runRegistry.getRun(runId);
      if (!run || run.agentId !== id) {
        return reply.status(404).send({ error: 'Session not found', runId });
      }

      const cancelled = await runRegistry.cancelRun(runId);
      if (!cancelled) {
        return reply.status(404).send({ error: 'Session not found', runId });
      }

      sse.broadcast(id, {
        type: 'CUSTOM',
        subtype: 'run_cancelled',
        timestamp: Date.now(),
        runId,
        agentId: id,
      });

      return reply.send({ cancelled: true, runId });
    },
  );

  // ── GET /api/agents/:id/runs — List all runs for an agent ─

  app.get(
    '/:id/runs',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const runs = runRegistry.getAllRuns(id);
      return reply.send(runs);
    },
  );

  // ── GET /api/agents/:id/runs/:runId — Get single run with messages ─

  app.get(
    '/:id/runs/:runId',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; runId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const run = runRegistry.getRun(runId);
      if (!run || run.agentId !== id) {
        return reply.status(404).send({ error: 'Run not found', runId });
      }

      const messages = await db.getMessages(run.conversationId);
      return reply.send({ run, messages });
    },
  );

  // ── GET /api/agents/:id/stream — SSE endpoint ─────────

  app.get(
    '/:id/stream',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial connection event
      reply.raw.write(
        `data: ${JSON.stringify({ type: 'CONNECTED', agentId: id, timestamp: Date.now() })}\n\n`,
      );

      const activeRuns = runRegistry.getActiveRuns(id);
      if (activeRuns.length > 0) {
        const currentRun = activeRuns[0];
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'RUN_STARTED',
            runId: currentRun.id,
            agentId: id,
            timestamp: currentRun.startedAt,
          })}\n\n`,
        );
      }

      const lastEventId = request.headers['last-event-id'] as string | undefined;
      sse.subscribe(id, reply, lastEventId);

      // Keep the request open; the SSEManager handles the lifecycle.
      // Fastify will not auto-end the reply because we wrote to raw.
    },
  );

  // ── GET /api/agents/:id/interrupts — List pending interrupts ────

  app.get(
    '/:id/interrupts',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { include_resolved?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { include_resolved?: string } | undefined;
      const includeResolved = query?.include_resolved === 'true';

      // Fast path: return in-memory pending interrupts
      const inMemory = interrupts.getPendingForAgent(id);
      const pending = inMemory.map((entry) => ({
        id: entry.runId,
        runId: entry.runId,
        agentId: id,
        toolCallId: entry.info.toolCallId,
        toolName: entry.info.toolName,
        args: entry.info.args,
        createdAt: entry.info.createdAt,
        status: 'pending' as const,
      }));

      // If DB is available and caller wants resolved history, merge from DB
      if (includeResolved) {
        try {
          const dbRows = await db.getPendingInterruptsForAgent(id);
          // Merge DB rows that aren't already in the in-memory set
          const seenIds = new Set(pending.map((p) => p.id));
          for (const row of dbRows) {
            if (!seenIds.has(row.id)) {
              pending.push({
                id: row.id,
                runId: row.runId,
                agentId: row.agentId,
                toolCallId: row.toolCallId,
                toolName: row.toolName,
                args: row.args as Record<string, unknown>,
                createdAt: row.createdAt,
                status: row.status as 'pending',
              });
            }
          }
        } catch {
          // DB query failed; return what we have from memory
        }
      }

      return reply.send({ interrupts: pending });
    },
  );

  // ── POST /api/agents/:id/interrupt — HITL response ────

  app.post(
    '/:id/interrupt',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { action: 'approve' | 'reject' | 'submit'; runId: string; data?: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { action?: string; runId?: string; data?: unknown } | undefined;

      if (
        !body ||
        (body.action !== 'approve' && body.action !== 'reject' && body.action !== 'submit') ||
        typeof body.runId !== 'string' ||
        body.runId.trim() === ''
      ) {
        return reply.status(400).send({
          error: 'action is required and must be "approve", "reject", or "submit", and runId is required',
        });
      }

      // Map 'submit' (used by document/form HITL) to 'approve' with data
      const resolveAction: 'approve' | 'reject' = body.action === 'submit' ? 'approve' : body.action as 'approve' | 'reject';

      // DB-first: check for the pending interrupt in persistent storage
      const dbInterrupt = await db.getPendingInterrupt(body.runId);

      if (dbInterrupt && dbInterrupt.agentId === id) {
        // Idempotency: already resolved
        if (dbInterrupt.status === 'resolved') {
          return reply.send({ alreadyResolved: true, action: dbInterrupt.resolvedAction });
        }

        // Resolve in DB first (durable)
        await db.resolveInterrupt(body.runId, resolveAction, body.data);
      }

      // Try in-memory fast path (also covers race where DB write hasn't landed yet)
      const inMemoryResolved = interrupts.resolve(body.runId, resolveAction, body.data, id);

      // If neither DB nor in-memory had the interrupt, 404
      if (!dbInterrupt && !inMemoryResolved) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }
      if (dbInterrupt && dbInterrupt.agentId !== id && !inMemoryResolved) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      if (inMemoryResolved) {
        sse.broadcast(id, {
          type: 'CUSTOM',
          subtype: 'interrupt_resolved',
          timestamp: Date.now(),
          agentId: id,
          action: resolveAction,
        });
        return reply.send({ resolved: true, action: resolveAction });
      }

      const sessionId = dbInterrupt?.sessionId;
      if (sessionId && dbInterrupt && sandboxSessionManager?.resumeWithInterruptResolution) {
        void sandboxSessionManager.resumeWithInterruptResolution(sessionId, dbInterrupt.runId, id).catch((err) => {
          console.error(`[agents] async resume failed for session ${sessionId}:`, err);
        });

        sse.broadcast(id, {
          type: 'CUSTOM',
          subtype: 'interrupt_resolved',
          timestamp: Date.now(),
          agentId: id,
          action: resolveAction,
          resuming: true,
        });

        return reply.status(202).send({ accepted: true, resuming: true, action: resolveAction });
      }

      sse.broadcast(id, {
        type: 'CUSTOM',
        subtype: 'interrupt_resolved',
        timestamp: Date.now(),
        agentId: id,
        action: resolveAction,
      });

      return reply.send({ resolved: true, action: resolveAction, note: 'Resolved in DB; session resume not available' });
    },
  );

  // ── POST /api/agents/:id/feedback — Submit feedback on a conversation ─

  app.post(
    '/:id/feedback',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          conversationId: string;
          messageId?: string;
          type: 'thumbs_up' | 'thumbs_down';
          comment?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        conversationId?: string;
        messageId?: string;
        type?: string;
        comment?: string;
      } | undefined;

      if (
        !body ||
        typeof body.conversationId !== 'string' ||
        (body.type !== 'thumbs_up' && body.type !== 'thumbs_down')
      ) {
        return reply.status(400).send({
          error: 'conversationId and type ("thumbs_up" or "thumbs_down") are required',
        });
      }

      // Store the feedback signal in the database
      const feedbackId = randomUUID();

      // Look up the actual runId for this conversation
      const allRuns = runRegistry.getAllRuns(id);
      const matchingRun = allRuns
        .filter((r) => r.conversationId === body.conversationId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const resolvedRunId = matchingRun?.id ?? body.conversationId!;

      if (eventBus) {
        eventBus.emit('feedback.received', {
          feedbackId,
          runId: resolvedRunId,
          agentId: id,
          type: body.type as 'thumbs_up' | 'thumbs_down',
          messageId: body.messageId ?? undefined,
          timestamp: Date.now(),
        });
      }

      const feedback = await db.saveFeedback({
        id: feedbackId,
        traceId: resolvedRunId,
        agentId: id,
        source: 'human',
        type: 'thumbs',
        value: {
          type: body.type,
          messageId: body.messageId ?? null,
          comment: body.comment ?? null,
        },
        createdAt: Date.now(),
      });

      // Trigger a learning pipeline run with the feedback (awaited)
      if (learningPipeline) {
        try {
          // Build a minimal trace from the conversation
          const messages = await db.getMessages(body.conversationId!);
          const userMsg = messages.find((m) => m.role === 'user');
          const trace = new TraceCollector(
            id,
            resolvedRunId,
            userMsg?.content ?? 'feedback-triggered',
          ).finalize(body.type === 'thumbs_up' ? 'success' : 'failure');

          const feedbackSignal = {
            id: feedbackId,
            traceId: resolvedRunId,
            agentId: id,
            source: 'human' as const,
            type: 'thumbs' as const,
            value: body.type === 'thumbs_up' ? 1 : -1,
            createdAt: new Date(),
          };

          const result = await learningPipeline.process(trace, [feedbackSignal]);

          return reply.status(201).send({
            feedbackId: feedback.id,
            type: body.type,
            learningTriggered: true,
            insightsGenerated: result.insights.length,
          });
        } catch (err) {
          console.error('Learning pipeline error (feedback):', err);
          return reply.status(201).send({
            feedbackId: feedback.id,
            type: body.type,
            learningTriggered: true,
            learningError: getErrorMessage(err),
          });
        }
      }

      return reply.status(201).send({
        feedbackId: feedback.id,
        type: body.type,
      });
    },
  );

  // ── GET /api/agents/:id/conversations — List conversations ─

  app.get(
    '/:id/conversations',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const conversations = await db.getConversationsForAgent(id);
      return reply.send(conversations);
    },
  );

  // ── GET /api/agents/:id/sessions — Active sessions ──────

  app.get(
    '/:id/sessions',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const sessions = await db.getSessionsForAgent(id);
      return reply.send({ sessions });
    },
  );

  app.post(
    '/:id/sessions/:sessionId/suspend',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sessionId } = request.params;

      if (!sandboxSessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const sessions = await db.getSandboxSessionsByAgent(agent.id);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }

        await sandboxSessionManager.suspendSession(sessionId, 'api_request');
        return reply.status(200).send({ sessionId, status: 'checkpointed' });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to suspend session', err));
      }
    },
  );

  app.post(
    '/:id/sessions/:sessionId/freeze',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sessionId } = request.params;

      if (!sandboxSessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const sessions = await db.getSandboxSessionsByAgent(agent.id);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }

        await sandboxSessionManager.freezeSession(sessionId);
        return reply.status(200).send({ sessionId, status: 'frozen' });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to freeze session', err));
      }
    },
  );

  app.post(
    '/:id/sessions/:sessionId/unfreeze',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sessionId } = request.params;

      if (!sandboxSessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const sessions = await db.getSandboxSessionsByAgent(agent.id);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }

        await sandboxSessionManager.unfreezeSession(sessionId);
        return reply.status(200).send({ sessionId, status: 'active' });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to unfreeze session', err));
      }
    },
  );

  app.post(
    '/:id/sessions/:sessionId/kill',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sessionId } = request.params;

      if (!sandboxSessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const sessions = await db.getSandboxSessionsByAgent(agent.id);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }

        await sandboxSessionManager.killSession(sessionId);
        return reply.status(204).send();
      } catch (err) {
        return reply.status(500).send(safeError('Failed to kill session', err));
      }
    },
  );

  // ── GET /api/agents/:id/conversations/:convId/messages ─

  app.get(
    '/:id/conversations/:convId/messages',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; convId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, convId } = request.params;

      // Ownership check: verify conversation belongs to this agent
      const conversation = await db.getConversation(convId);
      if (!conversation || conversation.agentId !== id) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }

      const messages = await db.getMessages(convId);
      return reply.send(messages);
    },
  );

  // ── GET /api/agents/:id/knowledge/stats — Knowledge stats ─

  app.get(
    '/:id/knowledge/stats',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      if (!knowledgeStore) {
        return reply.send({ totalItems: 0, categories: {}, recentItems: 0 });
      }

      const stats = await knowledgeStore.stats(id);
      return reply.send(stats);
    },
  );

  // ── GET /api/agents/:id/knowledge/:itemId — Get single knowledge item ─

  app.get(
    '/:id/knowledge/:itemId',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; itemId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, itemId } = request.params;

      if (!knowledgeStore) {
        return reply.status(404).send({ error: 'Knowledge item not found', itemId });
      }

      const item = await knowledgeStore.get(itemId);
      if (!item || item.agentId !== id) {
        return reply.status(404).send({ error: 'Knowledge item not found', itemId });
      }

      return reply.send(item);
    },
  );

  // ── GET /api/agents/:id/knowledge — List knowledge items ─

  app.get(
    '/:id/knowledge',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { q?: string; category?: string; limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { q?: string; category?: string; limit?: string; offset?: string };

      if (!knowledgeStore) {
        return reply.send({ items: [], total: 0 });
      }

      const result = await knowledgeStore.search(id, {
        q: query.q,
        category: query.category,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      const items = result.items.map((item) => ({
        id: item.id,
        content: item.content,
        category: item.category,
        source: item.source,
        createdAt: item.createdAt,
        relevance: item.effectiveness,
      }));

      return reply.send({ items, total: result.total });
    },
  );

  // ── GET /api/agents/:id/traces — List recent learning traces ─

  app.get(
    '/:id/traces',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { limit?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { limit?: string };

      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const traces = await db.getRecentTraces(id, limit);

      return reply.send(traces);
    },
  );

  // ── GET /api/agents/:id/files — List directory contents ──

  app.get(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string; runId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string; runId?: string };

      const agent = getRequestAgent(request);

      // Validate runId belongs to a real run for this agent
      if (query.runId) {
        const run = runRegistry.getRun(query.runId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Run not found', runId: query.runId });
        }
      }

      const baseDir = resolveBaseDir(agent, { runId: query.runId, dataDir });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const requestedPath = query.path || '.';

      const pathError = validateSandboxPath(baseDir, requestedPath);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

      const targetDir = resolve(baseDir, normalize(requestedPath));

      try {
        const dirEntries = await readdir(targetDir, { withFileTypes: true });
        const entries = await Promise.all(
          dirEntries
            .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && !isBlockedPath(e.name))
            .map(async (e) => {
              const entryPath = join(targetDir, e.name);
              let size = 0;
              try {
                const s = await stat(entryPath);
                size = s.size;
              } catch (err) {
                request.log.warn({ err }, 'Failed to stat file');
              }
              return {
                name: e.name,
                type: e.isDirectory() ? ('directory' as const) : ('file' as const),
                size,
              };
            }),
        );

        return reply.send({ entries });
      } catch (err) {
        return reply.status(400).send(safeError('Cannot read directory', err));
      }
    },
  );

  // ── GET /api/agents/:id/files/read — Read file content ──

  app.get(
    '/:id/files/read',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string; runId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string; runId?: string };

      const agent = getRequestAgent(request);

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      // Validate runId belongs to a real run for this agent
      if (query.runId) {
        const run = runRegistry.getRun(query.runId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Run not found', runId: query.runId });
        }
      }

      const baseDir = resolveBaseDir(agent, { runId: query.runId, dataDir });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(query.path));

      // Sandbox + blocked-path check
      const pathError = validateSandboxPath(baseDir, query.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

      try {
        const fileStat = await stat(targetFile);

        if (fileStat.isDirectory()) {
          return reply.status(400).send({ error: 'Path is a directory, not a file' });
        }

        // Max 50KB
        if (fileStat.size > 50 * 1024) {
          return reply.status(400).send({
            error: 'File too large',
            size: fileStat.size,
            maxSize: 50 * 1024,
          });
        }

        const content = await readFile(targetFile, 'utf-8');
        return reply.send({
          path: query.path,
          content,
          size: fileStat.size,
        });
      } catch (err) {
        return reply.status(400).send(safeError('Cannot read file', err));
      }
    },
  );

  // ── POST /api/agents/:id/files — Create a new file ──

  app.post(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { runId?: string };
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { runId?: string };
      const body = request.body as { path?: string; content?: string };

      const agent = getRequestAgent(request);

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      if (query.runId) {
        const run = runRegistry.getRun(query.runId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Run not found', runId: query.runId });
        }
      }

      const baseDir = resolveBaseDir(agent, { runId: query.runId, dataDir });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(body.path));

      // Sandbox + blocked-path check
      const pathError = validateSandboxPath(baseDir, body.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

      try {
        // Auto-create parent directories
        await mkdir(dirname(targetFile), { recursive: true });
        await writeFile(targetFile, body.content, 'utf-8');
        const fileStat = await stat(targetFile);
        return reply.status(201).send({ path: body.path, size: fileStat.size });
      } catch (err) {
        return reply.status(400).send(safeError('Cannot create file', err));
      }
    },
  );

  // ── PUT /api/agents/:id/files — Update an existing file ──

  app.put(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { runId?: string };
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { runId?: string };
      const body = request.body as { path?: string; content?: string };

      const agent = getRequestAgent(request);

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      if (query.runId) {
        const run = runRegistry.getRun(query.runId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Run not found', runId: query.runId });
        }
      }

      const baseDir = resolveBaseDir(agent, { runId: query.runId, dataDir });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(body.path));

      // Sandbox + blocked-path check
      const pathError = validateSandboxPath(baseDir, body.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

      try {
        // Verify file exists
        const fileStat = await stat(targetFile);
        if (fileStat.isDirectory()) {
          return reply.status(400).send({ error: 'Path is a directory, not a file' });
        }

        await writeFile(targetFile, body.content, 'utf-8');
        const updatedStat = await stat(targetFile);
        return reply.send({ path: body.path, size: updatedStat.size });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'File not found' });
        }
        return reply.status(400).send(safeError('Cannot update file', err));
      }
    },
  );

  // ── DELETE /api/agents/:id/files — Delete a file ──

  app.delete(
    '/:id/files',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string; runId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string; runId?: string };

      const agent = getRequestAgent(request);

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      if (query.runId) {
        const run = runRegistry.getRun(query.runId);
        if (!run || run.agentId !== id) {
          return reply.status(404).send({ error: 'Run not found', runId: query.runId });
        }
      }

      const baseDir = resolveBaseDir(agent, { runId: query.runId, dataDir });
      if (!baseDir) {
        return reply.status(500).send({ error: 'Agent has no workspace configured' });
      }
      const targetFile = resolve(baseDir, normalize(query.path));

      // Sandbox + blocked-path check
      const pathError = validateSandboxPath(baseDir, query.path);
      if (pathError) {
        return reply.status(pathError.status).send(pathError.body);
      }

      try {
        const fileStat = await stat(targetFile);
        if (fileStat.isDirectory()) {
          return reply.status(400).send({ error: 'Path is a directory, not a file' });
        }

        await unlink(targetFile);
        return reply.status(204).send();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'File not found' });
        }
        return reply.status(400).send(safeError('Cannot delete file', err));
      }
    },
  );

  // ── GET /api/agents/:id/traces/stats — Trace statistics ──

  app.get(
    '/:id/traces/stats',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const stats = await db.getTraceStats(id);
      return reply.send(stats);
    },
  );

  // ── GET /api/agents/:id/feedback/stats — Feedback statistics ──

  app.get(
    '/:id/feedback/stats',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const stats = await db.getFeedbackStats(id);
      return reply.send(stats);
    },
  );

  // ── GET /api/agents/:id/skills — List skills (SKILL.md format) ──

  app.get(
    '/:id/skills',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { runId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { runId?: string };

      if (!dataDir) {
        return reply.send({ skills: [] });
      }

      // When runId is provided, look in the session's merged skills dir first
      let skillsDir: string;
      if (query.runId) {
        const sessionSkills = resolve(join(dataDir, 'agents', id, 'sessions', query.runId, 'merged', 'skills'));
        skillsDir = existsSync(sessionSkills) ? sessionSkills : resolve(join(dataDir, 'agents', id, 'base', 'skills'));
      } else {
        skillsDir = resolve(join(dataDir, 'agents', id, 'base', 'skills'));
      }

      try {
        const manifests = await discoverSkills(skillsDir);
        const skills: LoadedSkill[] = await Promise.all(
          manifests.map((m) => loadSkill(m.path)),
        );

        return reply.send({ skills });
      } catch (err) {
        request.log.warn({ err }, 'Skill discovery failed');
        return reply.send({ skills: [] });
      }
    },
  );

  // ── POST /api/agents/:id/skills — Create a skill (SKILL.md format) ─────

  app.post(
    '/:id/skills',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { name: string; description: string; instructions: string; scripts?: Record<string, string> };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        name?: string;
        description?: string;
        instructions?: string;
        scripts?: Record<string, string>;
      } | undefined;

      if (
        !body ||
        typeof body.name !== 'string' ||
        body.name.trim() === '' ||
        typeof body.description !== 'string' ||
        typeof body.instructions !== 'string'
      ) {
        return reply.status(400).send({ error: 'name, description, and instructions are required' });
      }

      // Validate skill name format
      if (!isValidSkillName(body.name.trim())) {
        return reply.status(400).send({
          error: 'Invalid skill name: must be lowercase, hyphens only, max 64 characters',
        });
      }

      if (!dataDir) {
        return reply.status(500).send({ error: 'Data directory not configured' });
      }

      const skillsDir = resolve(join(dataDir, 'agents', id, 'base', 'skills'));
      mkdirSync(skillsDir, { recursive: true });

      // Sandbox check — make sure skill dir stays inside skillsDir
      const targetDir = resolve(join(skillsDir, body.name.trim()));
      if (!targetDir.startsWith(skillsDir)) {
        return reply.status(403).send({ error: 'Invalid skill name' });
      }

      if (existsSync(targetDir)) {
        return reply.status(409).send({ error: 'Skill already exists', name: body.name.trim() });
      }

      try {
        const skill = await createSkillDirectory(
          skillsDir,
          body.name.trim(),
          body.description.trim(),
          body.instructions.trim(),
          body.scripts,
        );
        return reply.status(201).send(skill);
      } catch (err) {
        return reply.status(500).send({ error: getErrorMessage(err) });
      }
    },
  );

  // ── PUT /api/agents/:id/skills/:skillName — Update a skill's SKILL.md ────

  app.put(
    '/:id/skills/:skillName',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string; skillName: string };
        Body: { description?: string; instructions?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id, skillName } = request.params;
      const body = request.body as { description?: string; instructions?: string } | undefined;

      if (!body || (body.description === undefined && body.instructions === undefined)) {
        return reply.status(400).send({ error: 'At least one of description or instructions is required' });
      }

      if (!dataDir) {
        return reply.status(500).send({ error: 'Data directory not configured' });
      }

      const skillsDir = resolve(join(dataDir, 'agents', id, 'base', 'skills'));
      const skillDir = resolve(join(skillsDir, skillName));

      // Sandbox check
      if (!skillDir.startsWith(skillsDir)) {
        return reply.status(403).send({ error: 'Invalid skill name' });
      }

      if (!existsSync(join(skillDir, 'SKILL.md'))) {
        return reply.status(404).send({ error: 'Skill not found', skillName });
      }

      try {
        const updated = await updateSkillMd(skillDir, {
          description: body.description,
          instructions: body.instructions,
        });
        return reply.send(updated);
      } catch (err) {
        return reply.status(500).send({ error: getErrorMessage(err) });
      }
    },
  );

  // ── DELETE /api/agents/:id/skills/:skillName — Delete a skill directory ──

  app.delete(
    '/:id/skills/:skillName',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string; skillName: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id, skillName } = request.params;

      if (!dataDir) {
        return reply.status(500).send({ error: 'Data directory not configured' });
      }

      const skillsDir = resolve(join(dataDir, 'agents', id, 'base', 'skills'));
      const skillDir = resolve(join(skillsDir, skillName));

      // Sandbox check
      if (!skillDir.startsWith(skillsDir)) {
        return reply.status(403).send({ error: 'Invalid skill name' });
      }

      if (!existsSync(skillDir) || !existsSync(join(skillDir, 'SKILL.md'))) {
        return reply.status(404).send({ error: 'Skill not found', skillName });
      }

      const { rm } = await import('node:fs/promises');
      await rm(skillDir, { recursive: true, force: true });
      return reply.status(204).send();
    },
  );

  // ── POST /api/agents/:id/workspace — Upload tarball to replace base workspace ─

  app.post(
    '/:id/workspace',
    {
      preHandler: [loadAgent],
      config: { rawBody: true },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { force?: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);

      if (!agent.workspaceDir) {
        return reply.status(400).send({ error: 'Agent has no workspace configured' });
      }

      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.includes('application/gzip') && !contentType.includes('application/x-gzip')) {
        return reply.status(415).send({ error: 'Content-Type must be application/gzip' });
      }

      try {
        const allSessions = await db.getActiveSandboxSessions();
        const agentSessions = allSessions.filter((s) => s.agentId === agent.id);

        if (agentSessions.length > 0) {
          const force = request.query.force === 'true';
          if (!force) {
            return reply.status(409).send({
              error: 'Agent has active sessions. Kill them first or use ?force=true',
              activeSessions: agentSessions.map((s) => s.id),
            });
          }

          if (sandboxSessionManager) {
            for (const session of agentSessions) {
              try {
                await sandboxSessionManager.killSession(session.id);
              } catch (err) {
                console.error(`[agents] failed to kill session ${session.id} during force upload:`, err);
              }
            }
          }
        }
      } catch (err) {
        return reply.status(500).send(safeError('Failed to check active sessions', err));
      }

      const baseDir = agent.workspaceDir;
      const tempDir = await mkdtemp(join(dirname(baseDir), '.upload-'));
      try {
        const maxTarBytes = settingsService
          ? (await settingsService.getAll()).maxTarUploadBytes
          : undefined;
        const result = await validateAndExtractTarball(request.raw, tempDir, {
          maxBytes: maxTarBytes,
        });

        const oldDir = baseDir + '.old';

        await rm(oldDir, { recursive: true, force: true });

        const baseExists = await stat(baseDir).then(() => true, () => false);
        if (baseExists) {
          await rename(baseDir, oldDir);
        }
        await rename(tempDir, baseDir);

        await rm(oldDir, { recursive: true, force: true });

        await chownRecursive(baseDir, 1000, 1000);

        return reply.status(201).send({ files: result.files, totalBytes: result.totalBytes });
      } catch (err) {
        await rm(tempDir, { recursive: true, force: true });

        if (err instanceof Error && err.message.includes('size exceeds')) {
          return reply.status(413).send({ error: err.message });
        }
        return reply.status(400).send(safeError('Failed to extract workspace tarball', err));
      }
    },
  );

  // ── Secrets CRUD ───────────────────────────────────────────

  // GET /:id/secrets — list secret key names (never values)
  app.get(
    '/:id/secrets',
    { preHandler: [loadAgent] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!secretProvider) {
        return reply.status(501).send({ error: 'Secret storage not configured' });
      }
      try {
        const keys = secretProvider.list(request.params.id);
        return reply.send({ keys });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to list secrets', err));
      }
    },
  );

  // POST /:id/secrets — set a secret { key, value }
  app.post(
    '/:id/secrets',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { key: string; value: string } }>,
      reply: FastifyReply,
    ) => {
      if (!secretProvider) {
        return reply.status(501).send({ error: 'Secret storage not configured' });
      }
      const { key, value } = request.body ?? ({} as Record<string, string>);
      if (!key || typeof key !== 'string' || !value || typeof value !== 'string') {
        return reply.status(400).send({ error: 'key and value are required strings' });
      }
      try {
        secretProvider.set(request.params.id, key, value);
        return reply.status(201).send({ key });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to set secret', err));
      }
    },
  );

  // DELETE /:id/secrets/:key — delete a secret
  app.delete(
    '/:id/secrets/:key',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; key: string } }>,
      reply: FastifyReply,
    ) => {
      if (!secretProvider) {
        return reply.status(501).send({ error: 'Secret storage not configured' });
      }
      try {
        secretProvider.delete(request.params.id, request.params.key);
        return reply.status(204).send();
      } catch (err) {
        return reply.status(500).send(safeError('Failed to delete secret', err));
      }
    },
  );

  app.post('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { url?: string; events?: string[]; secret?: string } | undefined;

    if (!body?.url || !body?.events?.length) {
      return reply.status(400).send({ error: 'url and events are required' });
    }

    const invalidEvents = body.events.filter((eventType) => !validWebhookEvents.includes(eventType));
    if (invalidEvents.length > 0) {
      return reply.status(400).send({ error: `Invalid event types: ${invalidEvents.join(', ')}`, validEvents: validWebhookEvents });
    }

    const now = Date.now();
    const webhook = await db.createWebhook({
      id: randomUUID(),
      agentId: id,
      url: body.url,
      events: body.events,
      secret: body.secret ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return reply.status(201).send(webhook);
  });

  app.get('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const hooks = await db.listWebhooks(id);
    return reply.send(hooks);
  });

  app.delete('/:id/webhooks/:webhookId', { preHandler: [loadAgent] }, async (request, reply) => {
    const { webhookId } = request.params as { id: string; webhookId: string };
    const deleted = await db.deleteWebhook(webhookId);
    if (!deleted) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return reply.status(204).send();
  });
}

export interface SessionsRouteOptions {
  runRegistry: RunRegistry;
}

export async function sessionsRoutes(
  app: FastifyInstance,
  opts: SessionsRouteOptions,
): Promise<void> {
  const { runRegistry } = opts;

  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const activeSessions = runRegistry.getActiveRuns();
    return reply.send(activeSessions);
  });

  app.post('/:id/resume', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const run = runRegistry.getRun(id);
    if (!run) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    if (run.status !== 'suspended') {
      return reply.status(400).send({
        error: `Session is not suspended (current status: ${run.status})`,
      });
    }

    const resumed = await runRegistry.resumeRun(id);
    if (!resumed) {
      return reply.status(500).send({ error: 'Failed to resume session' });
    }

    return reply.send({
      id: resumed.id,
      agentId: resumed.agentId,
      status: resumed.status,
      resumedAt: resumed.resumedAt,
    });
  });
}
