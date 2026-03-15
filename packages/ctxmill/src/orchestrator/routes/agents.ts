import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, normalize, join, dirname } from 'node:path';
import { readdir, stat, readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SSEManager } from '../sse.js';
import type { InterruptManager } from '../interrupt.js';
import type { RunRegistry } from '../run-registry.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { AgentExecutor } from '../../agent/executor.js';
import type { AgentDefinition } from '../../types.js';
import type { AgentModelConfig } from '../../harness/types.js';
import type { LearningPipeline } from '../../learning/types.js';
import type { KnowledgeStore } from '../../knowledge/types.js';
import type { AgentRunService } from '../agent-run-service.js';
import type { TypedEventBus } from '../../events/bus.js';
import { TraceCollector } from '../../learning/trace.js';
import type { EnvironmentFactory } from '../../workspace/types.js';
import { ensureAgentWorkspace as ensureAgentWorkspaceShared, seedAgentWorkspace } from '../../workspace/ensure.js';
import { getErrorMessage } from '../../util/errors.js';
import type { ManifestService } from '../../manifest/index.js';
import {
  discoverSkills,
  discoverLegacySkills,
  loadSkill,
  createSkillDirectory,
  updateSkillMd,
  isValidSkillName,
} from '../../skills/loader.js';
import type { LoadedSkill, LegacySkill } from '@ctxmill/shared';
import {
  isBlockedPath,
  resolveBaseDir,
  validateSandboxPath,
  resolveSessionDir,
  mapMessagesToInternal,
  requireAgent,
} from './agent-helpers.js';

/** Safely parse JSON, returning a fallback on failure. */
function safeJsonParse(value: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Build a safe error response — only include details in development mode. */
function safeError(message: string, err: unknown): { error: string; detail?: string } {
  console.error(`[agents] endpoint error:`, err);
  if (process.env.NODE_ENV === 'development') {
    return { error: message, detail: String(err) };
  }
  return { error: 'Internal error' };
}

/** Convert a DB agent row to an AgentDefinition for the executor. */
function toAgentDef(agent: { name: string; model: string; systemPrompt: string; tools: string[]; description?: string | null; metadata?: Record<string, unknown> | null; workspaceDir?: string | null; harness?: string | null; modelConfig?: string | null }): AgentDefinition {
  return {
    name: agent.name,
    model: agent.model,
    harness: agent.harness ?? undefined,
    modelConfig: agent.modelConfig ? safeJsonParse(agent.modelConfig) as AgentModelConfig : undefined,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
    description: agent.description ?? undefined,
    metadata: agent.metadata ?? undefined,
    workspaceDir: agent.workspaceDir ?? undefined,
  };
}

/** Shared application context injected via plugin options. */
export interface AgentRouteOptions {
  db: DatabaseRepository;
  sse: SSEManager;
  interrupts: InterruptManager;
  executor: AgentExecutor;
  runRegistry: RunRegistry;
  learningPipeline?: LearningPipeline;
  knowledgeStore?: KnowledgeStore;
  agentRunService: AgentRunService;
  eventBus?: TypedEventBus;
  /** Path to the .ctxmill data directory for agent workspaces. */
  dataDir?: string;
  /** Factory for creating session execution environments. */
  envFactory?: EnvironmentFactory;
  manifestService?: ManifestService;
}

export async function agentRoutes(
  app: FastifyInstance,
  opts: AgentRouteOptions,
): Promise<void> {
  const { db, sse, interrupts, executor, runRegistry, learningPipeline, knowledgeStore, agentRunService, eventBus, dataDir, envFactory, manifestService } = opts;

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

  // ── GET /api/agents — List all agents ──────────────────

  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const agentList = await db.listAgents();
    const activeAgentIds = new Set(sse.getActiveAgentIds());
    const enriched = agentList.map((agent) => {
      const allRuns = runRegistry.getAllRuns(agent.id);
      const activeRuns = runRegistry.getActiveRuns(agent.id);
      // Last 5 runs, most recent first
      const recentRuns = [...allRuns]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 5);

      return {
        ...agent,
        sseClients: sse.getClientCount(agent.id),
        activeSessions: activeAgentIds.has(agent.id) ? sse.getClientCount(agent.id) : 0,
        lastActivity: sse.getLastActivity(agent.id) ?? null,
        activeRuns: activeRuns.length,
        runs: recentRuns,
      };
    });
    return reply.send(enriched);
  });

  // ── POST /api/agents — Create a new agent ───────────────

  app.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          name: string;
          model: string;
          systemPrompt: string;
          tools: string[];
          description?: string;
          metadata?: Record<string, unknown>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as {
        name?: string;
        model?: string;
        systemPrompt?: string;
        tools?: string[];
        description?: string;
        metadata?: Record<string, unknown>;
      } | undefined;

      if (
        !body ||
        typeof body.name !== 'string' || body.name.trim() === '' ||
        typeof body.model !== 'string' || body.model.trim() === '' ||
        typeof body.systemPrompt !== 'string' ||
        !Array.isArray(body.tools)
      ) {
        return reply.status(400).send({
          error: 'name, model, systemPrompt, and tools are required',
        });
      }

      let agent = await db.createAgent({
        name: body.name,
        model: body.model,
        systemPrompt: body.systemPrompt,
        tools: body.tools,
        description: body.description ?? null,
        metadata: body.metadata ?? null,
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

      return reply.status(201).send(agent);
    },
  );

  // ── POST /api/agents/import — Import agent from manifest ──
  app.post(
    '/import',
    async (
      request: FastifyRequest<{
        Body: { content: string; format?: 'yaml' | 'json'; changedBy?: string; changeNote?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!manifestService) {
        return reply.status(501).send({ error: 'Manifest service not configured' });
      }
      try {
        const contentType = request.headers['content-type'] ?? '';
        let content: string;
        let changedBy: string | undefined;
        let changeNote: string | undefined;

        if (contentType.includes('text/yaml') || contentType.includes('application/x-yaml')) {
          content = request.body as unknown as string;
        } else {
          const body = request.body as { content?: string; changedBy?: string; changeNote?: string } | undefined;
          if (!body || typeof body.content !== 'string') {
            return reply.status(400).send({ error: 'content is required' });
          }
          content = body.content;
          changedBy = body.changedBy;
          changeNote = body.changeNote;
        }

        const result = await manifestService.importManifest(content, { changedBy, changeNote });
        return reply.status(result.created ? 201 : 200).send(result);
      } catch (err) {
        if (err instanceof Error && err.name === 'ZodError') {
          return reply.status(400).send({ error: 'Manifest validation failed', details: String(err) });
        }
        return reply.status(400).send(safeError('Failed to import manifest', err));
      }
    },
  );

  // ── GET /api/agents/:id/manifest — Export agent manifest ──
  app.get(
    '/:id/manifest',
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { format?: string } }>,
      reply: FastifyReply,
    ) => {
      if (!manifestService) {
        return reply.status(501).send({ error: 'Manifest service not configured' });
      }
      try {
        const { id } = request.params;
        const query = request.query as { format?: string };
        const format = query.format === 'json' ? 'json' : 'yaml';

        const serialized = await manifestService.exportManifest(id, format);
        if (format === 'json') {
          return reply.type('application/json').send(serialized);
        }
        return reply.type('text/yaml').send(serialized);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Agent not found')) {
          return reply.status(404).send({ error: 'Agent not found' });
        }
        return reply.status(500).send(safeError('Failed to export manifest', err));
      }
    },
  );

  // ── GET /api/agents/:id/versions — Get version history ──
  app.get(
    '/:id/versions',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params;
        const versions = await db.getAgentVersions(id);
        return reply.send({ versions });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to get versions', err));
      }
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
          model?: string;
          systemPrompt?: string;
          tools?: string[];
          description?: string;
          metadata?: Record<string, unknown>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        name?: string;
        model?: string;
        systemPrompt?: string;
        tools?: string[];
        description?: string;
        metadata?: Record<string, unknown>;
      } | undefined;

      if (!body || Object.keys(body).length === 0) {
        return reply.status(400).send({ error: 'Request body must contain at least one field to update' });
      }

      const updateData: Record<string, unknown> = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.model !== undefined) updateData.model = body.model;
      if (body.systemPrompt !== undefined) updateData.systemPrompt = body.systemPrompt;
      if (body.tools !== undefined) updateData.tools = body.tools;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.metadata !== undefined) updateData.metadata = body.metadata;

      const updated = await db.updateAgent(id, updateData);

      return reply.send(updated);
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
        ...agent,
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

      // Spawn the agent executor asynchronously — don't block the response.
      // DB is the single source of truth for agent definitions.
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
      });

      return reply.status(201).send({
        messageId: message.id,
        conversationId,
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
      });

      return reply.status(201).send({
        runId: run.id,
        conversationId,
      });
    },
  );

  // ── POST /api/agents/:id/runs/:runId/cancel — Cancel a run ─

  app.post(
    '/:id/runs/:runId/cancel',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string; runId: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const cancelled = await runRegistry.cancelRun(runId);
      if (!cancelled) {
        return reply.status(404).send({ error: 'Run not found', runId });
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

      const agent = getRequestAgent(request);

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

      // Subscribe to agent events — heartbeat + cleanup handled by SSEManager
      sse.subscribe(id, reply);

      // Keep the request open; the SSEManager handles the lifecycle.
      // Fastify will not auto-end the reply because we wrote to raw.
    },
  );

  // ── POST /api/agents/:id/interrupt — HITL response ────

  app.post(
    '/:id/interrupt',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { action: 'approve' | 'reject'; runId?: string; data?: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { action?: string; runId?: string; data?: unknown } | undefined;

      if (!body || (body.action !== 'approve' && body.action !== 'reject' && body.action !== 'submit')) {
        return reply.status(400).send({
          error: 'action is required and must be "approve", "reject", or "submit"',
        });
      }

      // Map 'submit' (used by document/form HITL) to 'approve' with data
      const resolveAction: 'approve' | 'reject' = body.action === 'submit' ? 'approve' : body.action as 'approve' | 'reject';

      // Use runId from the request body; fall back to agentId for backward compatibility
      const resolveKey = body.runId ?? id;

      const resolved = interrupts.resolve(
        resolveKey,
        resolveAction,
        body.data,
        id,
      );
      if (!resolved) {
        return reply.status(404).send({
          error: 'No pending interrupt for agent',
          agentId: id,
        });
      }

      // Broadcast the interrupt resolution via SSE
      sse.broadcast(id, {
        type: 'CUSTOM',
        subtype: 'interrupt_resolved',
        timestamp: Date.now(),
        agentId: id,
        action: resolveAction,
      });

      return reply.send({ resolved: true, action: resolveAction });
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

  // ── GET /api/agents/:id/conversations/:convId/messages ─

  app.get(
    '/:id/conversations/:convId/messages',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; convId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, convId } = request.params;

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
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { path?: string; content?: string };

      const agent = getRequestAgent(request);

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      const baseDir = resolveBaseDir(agent);
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
        Body: { path: string; content: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { path?: string; content?: string };

      const agent = getRequestAgent(request);

      if (!body.path || typeof body.content !== 'string') {
        return reply.status(400).send({ error: 'path and content are required' });
      }

      const baseDir = resolveBaseDir(agent);
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
        Querystring: { path?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string };

      const agent = getRequestAgent(request);

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      const baseDir = resolveBaseDir(agent);
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

  // ── GET /api/agents/:id/skills — List skills (SKILL.md format + legacy) ──

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
        return reply.send({ skills: [], legacySkills: [] });
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
        // Discover standard SKILL.md skills
        const manifests = await discoverSkills(skillsDir);
        const skills: LoadedSkill[] = await Promise.all(
          manifests.map((m) => loadSkill(m.path)),
        );

        // Discover legacy loose .ts/.js files for backward compat
        const legacySkills = await discoverLegacySkills(skillsDir);

        return reply.send({ skills, legacySkills });
      } catch (err) {
        request.log.warn({ err }, 'Skill discovery failed');
        return reply.send({ skills: [], legacySkills: [] });
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

      // Support both new format (directory) and legacy (loose file)
      if (existsSync(skillDir) && existsSync(join(skillDir, 'SKILL.md'))) {
        // New format — remove the entire directory
        const { rm } = await import('node:fs/promises');
        await rm(skillDir, { recursive: true, force: true });
        return reply.status(204).send();
      }

      // Legacy fallback — try to delete a loose .ts or .js file
      const legacyTs = resolve(join(skillsDir, `${skillName}.ts`));
      const legacyJs = resolve(join(skillsDir, `${skillName}.js`));
      const legacyPath = existsSync(legacyTs) ? legacyTs : existsSync(legacyJs) ? legacyJs : null;

      if (!legacyPath) {
        return reply.status(404).send({ error: 'Skill not found', skillName });
      }

      await unlink(legacyPath);
      return reply.status(204).send();
    },
  );

  // ── GET /api/agents/:id/runs/:runId/diff — Get session diff ─

  app.get(
    '/:id/runs/:runId/diff',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; runId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const agent = getRequestAgent(request);

      const run = runRegistry.getRun(runId);
      if (!run || run.agentId !== id) {
        return reply.status(404).send({ error: 'Run not found', runId });
      }

      if (!run.sessionDir || !envFactory || !agent.workspaceDir) {
        return reply.send({ changes: [] });
      }

      try {
        const sessionsDir = resolveSessionDir(agent);
        const env = envFactory.create(agent.workspaceDir, runId, sessionsDir);
        await env.setup();
        const changes = await env.diff();
        // Don't tear down — let the session persist for promote/fork
        return reply.send({ changes });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to compute diff', err));
      }
    },
  );

  // ── POST /api/agents/:id/runs/:runId/promote — Promote session changes to base ─

  app.post(
    '/:id/runs/:runId/promote',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; runId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const agent = getRequestAgent(request);

      const run = runRegistry.getRun(runId);
      if (!run || run.agentId !== id) {
        return reply.status(404).send({ error: 'Run not found', runId });
      }

      if (!run.sessionDir || !envFactory || !agent.workspaceDir) {
        return reply.status(400).send({ error: 'No session environment for this run' });
      }

      try {
        const sessionsDir = resolveSessionDir(agent);
        const env = envFactory.create(agent.workspaceDir, runId, sessionsDir);
        await env.setup();
        const result = await env.promote();
        await env.teardown();
        return reply.send(result);
      } catch (err) {
        return reply.status(500).send(safeError('Failed to promote session', err));
      }
    },
  );

  // ── POST /api/agents/:id/runs/:runId/fork — Fork session into a new agent ─

  app.post(
    '/:id/runs/:runId/fork',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string; runId: string };
        Body: { name: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;
      const body = request.body as { name?: string } | undefined;

      if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.status(400).send({ error: 'name is required for the forked agent' });
      }

      const agent = getRequestAgent(request);

      const run = runRegistry.getRun(runId);
      if (!run || run.agentId !== id) {
        return reply.status(404).send({ error: 'Run not found', runId });
      }

      if (!run.sessionDir || !envFactory || !agent.workspaceDir) {
        return reply.status(400).send({ error: 'No session environment for this run' });
      }

      try {
        // Create a new agent (cloned from existing)
        const newAgent = await db.createAgent({
          name: body.name,
          model: agent.model,
          systemPrompt: agent.systemPrompt,
          tools: agent.tools,
          description: agent.description,
          metadata: agent.metadata,
        });

        // Create workspace for the new agent
        const newWorkspaceDir = ensureAgentWorkspace(newAgent.id);
        if (newWorkspaceDir) {
          await db.updateAgent(newAgent.id, { workspaceDir: newWorkspaceDir });
        }

        // Fork the session environment to the new agent's base workspace
        try {
          const sessionsDir = resolveSessionDir(agent);
          const env = envFactory.create(agent.workspaceDir, runId, sessionsDir);
          await env.setup();
          if (newWorkspaceDir) {
            await env.fork(newWorkspaceDir);
          }
        } catch (forkErr) {
          // Clean up orphaned agent on fork failure
          try {
            await db.deleteAgentCascade(newAgent.id);
            if (newWorkspaceDir) {
              const { rmSync: rmSyncFs } = await import('node:fs');
              rmSyncFs(newWorkspaceDir, { recursive: true, force: true });
            }
          } catch { /* best-effort cleanup */ }
          throw forkErr;
        }

        return reply.status(201).send({ agentId: newAgent.id, name: body.name });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to fork session', err));
      }
    },
  );

  // ── DELETE /api/agents/:id/runs/:runId/session — Discard session ─

  app.delete(
    '/:id/runs/:runId/session',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; runId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const agent = getRequestAgent(request);

      const run = runRegistry.getRun(runId);
      if (!run || run.agentId !== id) {
        return reply.status(404).send({ error: 'Run not found', runId });
      }

      if (!run.sessionDir || !envFactory || !agent.workspaceDir) {
        return reply.send({ discarded: true });
      }

      try {
        const sessionsDir = resolveSessionDir(agent);
        const env = envFactory.create(agent.workspaceDir, runId, sessionsDir);
        await env.setup();
        await env.teardown();
        return reply.send({ discarded: true });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to discard session', err));
      }
    },
  );
}

// ── GET /api/runs — Top-level route (registered separately) ─

export interface RunsRouteOptions {
  runRegistry: RunRegistry;
}

export async function runsRoutes(
  app: FastifyInstance,
  opts: RunsRouteOptions,
): Promise<void> {
  const { runRegistry } = opts;

  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const activeRuns = runRegistry.getActiveRuns();
    return reply.send(activeRuns);
  });
}
