import { randomUUID } from 'node:crypto';
import { resolve, normalize, join } from 'node:path';
import { readdir, stat, readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SSEManager } from '../sse.js';
import type { InterruptManager } from '../interrupt.js';
import type { RunRegistry } from '../run-registry.js';
import type { DatabaseRepository } from '../../database/repository.js';
import type { AgentExecutor } from '../../agent/executor.js';
import type { AgentDefinition, Message } from '../../types.js';
import type { LearningPipeline } from '../../learning/types.js';
import type { KnowledgeStore } from '../../knowledge/types.js';
import type { AgentRunService } from '../agent-run-service.js';
import { TraceCollector } from '../../learning/trace.js';

/** Patterns that should never be exposed via the file browsing API. */
const BLOCKED_PATTERNS = ['.env', '.git', '.ctxmill', 'credentials', '.pem', '.key', '.secret'];

/** Check if a filename or path segment matches any blocked pattern. */
function isBlockedPath(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Build a safe error response — only include details in development mode. */
function safeError(message: string, err: unknown): { error: string; detail?: string } {
  console.error(`[agents] endpoint error:`, err);
  if (process.env.NODE_ENV === 'development') {
    return { error: message, detail: String(err) };
  }
  return { error: 'Internal error' };
}

/** Shared application context injected via plugin options. */
export interface AgentRouteOptions {
  db: DatabaseRepository;
  sse: SSEManager;
  interrupts: InterruptManager;
  executor: AgentExecutor;
  /** Map of agent ID → AgentDefinition for registered agents. */
  agents: Map<string, AgentDefinition>;
  runRegistry: RunRegistry;
  learningPipeline?: LearningPipeline;
  knowledgeStore?: KnowledgeStore;
  agentRunService: AgentRunService;
}

export async function agentRoutes(
  app: FastifyInstance,
  opts: AgentRouteOptions,
): Promise<void> {
  const { db, sse, interrupts, executor, agents, runRegistry, learningPipeline, knowledgeStore, agentRunService } = opts;

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

  // ── GET /api/agents/:id — Get agent detail ─────────────

  app.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const conversations = await db.getConversationsForAgent(id);
      return reply.send({
        ...agent,
        conversationCount: conversations.length,
        sseClients: sse.getClientCount(id),
        hasPendingInterrupt: interrupts.hasPending(id),
      });
    },
  );

  // ── POST /api/agents/:id/message — Send message to agent ─

  app.post(
    '/:id/message',
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

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
      const agentDef = agents.get(id);
      if (agentDef) {
        const allMessages = await db.getMessages(conversationId);
        const messages: Message[] = allMessages.map((m) => ({
          id: m.id,
          agentId: m.agentId ?? id,
          role: m.role as Message['role'],
          content: m.content,
          toolCallId: m.toolCallId ?? undefined,
          createdAt: new Date(m.createdAt),
        }));

        // Delegate to AgentRunService (fire-and-forget)
        void agentRunService.executeRun({
          agentDef,
          messages,
          agentId: id,
          conversationId,
          runId: run.id,
          taskDescription: body.content,
        });
      }

      return reply.status(201).send({
        messageId: message.id,
        conversationId,
      });
    },
  );

  // ── POST /api/agents/:id/run — Start a background agent run ─

  app.post(
    '/:id/run',
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

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
      const agentDef = agents.get(id);
      if (agentDef) {
        // Create a synthetic user message from the task
        await db.addMessage({
          agentId: id,
          conversationId,
          role: 'user',
          content: body.task,
        });

        const allMessages = await db.getMessages(conversationId);
        const messages: Message[] = allMessages.map((m) => ({
          id: m.id,
          agentId: m.agentId ?? id,
          role: m.role as Message['role'],
          content: m.content,
          toolCallId: m.toolCallId ?? undefined,
          createdAt: new Date(m.createdAt),
        }));

        // Delegate to AgentRunService (fire-and-forget)
        void agentRunService.executeRun({
          agentDef,
          messages,
          agentId: id,
          conversationId,
          runId: run.id,
          taskDescription: body.task ?? 'background run',
        });
      }

      return reply.status(201).send({
        runId: run.id,
        conversationId,
      });
    },
  );

  // ── POST /api/agents/:id/runs/:runId/cancel — Cancel a run ─

  app.post(
    '/:id/runs/:runId/cancel',
    async (
      request: FastifyRequest<{
        Params: { id: string; runId: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const runs = runRegistry.getAllRuns(id);
      return reply.send(runs);
    },
  );

  // ── GET /api/agents/:id/runs/:runId — Get single run with messages ─

  app.get(
    '/:id/runs/:runId',
    async (
      request: FastifyRequest<{ Params: { id: string; runId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, runId } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
        Body: { action: 'approve' | 'reject'; data?: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { action?: string; data?: unknown } | undefined;

      if (!body || (body.action !== 'approve' && body.action !== 'reject')) {
        return reply.status(400).send({
          error: 'action is required and must be "approve" or "reject"',
        });
      }

      const resolved = interrupts.resolve(
        id,
        body.action as 'approve' | 'reject',
        body.data,
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
        action: body.action,
      });

      return reply.send({ resolved: true, action: body.action });
    },
  );

  // ── POST /api/agents/:id/feedback — Submit feedback on a conversation ─

  app.post(
    '/:id/feedback',
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

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      // Store the feedback signal in the database
      const feedbackId = randomUUID();
      const feedback = await db.saveFeedback({
        id: feedbackId,
        traceId: body.conversationId,
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
            body.conversationId!,
            userMsg?.content ?? 'feedback-triggered',
          ).finalize(body.type === 'thumbs_up' ? 'success' : 'failure');

          const feedbackSignal = {
            id: feedbackId,
            traceId: body.conversationId!,
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
            learningError: err instanceof Error ? err.message : String(err),
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
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const conversations = await db.getConversationsForAgent(id);
      return reply.send(conversations);
    },
  );

  // ── GET /api/agents/:id/sessions — Active sessions ──────

  app.get(
    '/:id/sessions',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const sessions = await db.getSessionsForAgent(id);
      return reply.send({ sessions });
    },
  );

  // ── GET /api/agents/:id/conversations/:convId/messages ─

  app.get(
    '/:id/conversations/:convId/messages',
    async (
      request: FastifyRequest<{ Params: { id: string; convId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, convId } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const messages = await db.getMessages(convId);
      return reply.send(messages);
    },
  );

  // ── GET /api/agents/:id/knowledge/stats — Knowledge stats ─

  app.get(
    '/:id/knowledge/stats',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
    async (
      request: FastifyRequest<{ Params: { id: string; itemId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, itemId } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { q?: string; category?: string; limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { q?: string; category?: string; limit?: string; offset?: string };

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

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
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { limit?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { limit?: string };

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const traces = await db.getRecentTraces(id, limit);

      return reply.send(traces);
    },
  );

  // ── GET /api/agents/:id/files — List directory contents ──

  app.get(
    '/:id/files',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string };

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const baseDir = resolve(process.cwd());
      const requestedPath = query.path || '.';
      const targetDir = resolve(baseDir, normalize(requestedPath));

      // Sandbox check: ensure the resolved path is within baseDir
      if (!targetDir.startsWith(baseDir)) {
        return reply.status(403).send({ error: 'Path outside project directory' });
      }

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
              } catch {
                // ignore stat errors
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
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { path?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { path?: string };

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      if (!query.path) {
        return reply.status(400).send({ error: 'path query parameter is required' });
      }

      const baseDir = resolve(process.cwd());
      const targetFile = resolve(baseDir, normalize(query.path));

      // Sandbox check
      if (!targetFile.startsWith(baseDir)) {
        return reply.status(403).send({ error: 'Path outside project directory' });
      }

      // Block sensitive file patterns
      const pathSegments = query.path.split('/');
      if (pathSegments.some((seg) => isBlockedPath(seg))) {
        return reply.status(403).send({ error: 'Access to this file is forbidden' });
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

  // ── GET /api/agents/:id/traces/stats — Trace statistics ──

  app.get(
    '/:id/traces/stats',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const stats = await db.getTraceStats(id);
      return reply.send(stats);
    },
  );

  // ── GET /api/agents/:id/feedback/stats — Feedback statistics ──

  app.get(
    '/:id/feedback/stats',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const agent = await db.getAgent(id);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: id });
      }

      const stats = await db.getFeedbackStats(id);
      return reply.send(stats);
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
