import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { ConcurrencyLimitError } from '../../session-manager/concurrency-limit-error.js';
import type { RuntimeSandboxSecrets } from '../../session-manager/runtime-sandbox-secrets.js';
import { getRequestAgent, safeError, toApiAgentSession } from './helpers.js';
import type { AgentSubRouteOptions, StoredAgent } from './types.js';

// Session/conversation/run ID semantics are documented in
// docs/contracts/session-identity.md. In particular, the `sessionId` returned
// by message/session creation routes is the turn/run id, not the persistent
// sandbox session id.
function sendLegacySandboxAdminGone(
  reply: FastifyReply,
  action: 'suspend' | 'kill',
  sessionId: string,
) {
  return reply.status(410).send({
    error: `Legacy session admin route removed. Use /api/agents/:id/sandbox-sessions/:sessionId/${action}.`,
    sessionId,
  });
}

export async function sessionRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, interrupts, sessionManager, eventBus, runStartupService, loadAgent } = opts;

  const parseSandboxSecrets = (value: unknown): RuntimeSandboxSecrets | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('sandboxSecrets must be an object of environment variable names to string values');
    }

    const secrets: Record<string, string> = {};
    for (const [key, secretValue] of Object.entries(value)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`Invalid sandbox secret key: ${key}`);
      }
      if (typeof secretValue !== 'string') {
        throw new Error(`sandboxSecrets.${key} must be a string`);
      }
      secrets[key] = secretValue;
    }
    return secrets;
  };

  const prepareRunStart = async (
    agent: StoredAgent,
    agentId: string,
    content: string,
    mode: 'interactive' | 'background',
    options?: {
      conversationId?: string;
      requestedTurnId?: string;
      requireExistingConversation?: boolean;
      emitUserMessageEvent?: boolean;
      sandboxSecrets?: RuntimeSandboxSecrets;
    },
  ) => {
    return runStartupService.prepareRunStart({
      agent,
      agentId,
      content,
      mode,
      conversationId: options?.conversationId,
      requestedTurnId: options?.requestedTurnId,
      requireExistingConversation: options?.requireExistingConversation,
      emitUserMessageEvent: options?.emitUserMessageEvent,
      sandboxSecrets: options?.sandboxSecrets,
    });
  };

  const launchPreparedRun = (
    agentId: string,
    start: Awaited<ReturnType<typeof prepareRunStart>>,
  ) => {
    void runStartupService.launchPreparedRun(start, agentId).catch((err) => {
      console.error(`[agents] executeSession failed for agent ${agentId}, session ${start.turnId}:`, err);
    });
  };

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

      try {
        const start = await prepareRunStart(agent, id, body.content, 'interactive', {
          conversationId: body.conversationId,
          emitUserMessageEvent: true,
        });
        launchPreparedRun(id, start);
        return reply.status(201).send({
          messageId: start.messageId,
          conversationId: start.conversationId,
          sessionId: start.turnId,
        });
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          return reply
            .status(err.statusCode)
            .header('Retry-After', String(err.retryAfterSec))
            .send({
              error: err.message,
              code: 'concurrency_limit_reached',
              agentId: err.agentId,
              maxConcurrent: err.maxConcurrent,
              retryAfterSec: err.retryAfterSec,
            });
        }
        if (err instanceof Error && err.message.startsWith('Conversation ')) {
          return reply.status(404).send({ error: err.message });
        }
        return reply.status(500).send(safeError('Failed to start session', err));
      }
    },
  );

  app.post(
    '/:id/session',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { task: string; mode?: string; sandboxSecrets?: Record<string, string> };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { task?: string; mode?: string; sandboxSecrets?: unknown } | undefined;

      if (!body || typeof body.task !== 'string' || body.task.trim() === '') {
        return reply.status(400).send({ error: 'task is required and must be a non-empty string' });
      }

      const agent = getRequestAgent(request);
      try {
        const sandboxSecrets = parseSandboxSecrets(body.sandboxSecrets);
        const start = await prepareRunStart(agent, id, body.task, 'background', {
          emitUserMessageEvent: false,
          sandboxSecrets,
        });
        await db.updateAgentStatus(id, 'running');
        launchPreparedRun(id, start);
        return reply.status(201).send({
          sessionId: start.turnId,
          conversationId: start.conversationId,
          sandboxSessionId: null,  // populated asynchronously; poll GET /:id/sessions/:sessionId until non-null to get the id required by /sandbox-sessions/:id/suspend
        });
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          return reply
            .status(err.statusCode)
            .header('Retry-After', String(err.retryAfterSec))
            .send({
              error: err.message,
              code: 'concurrency_limit_reached',
              agentId: err.agentId,
              maxConcurrent: err.maxConcurrent,
              retryAfterSec: err.retryAfterSec,
            });
        }
        if (err instanceof Error && /sandbox secret|sandboxSecrets/i.test(err.message)) {
          return reply.status(400).send({ error: err.message });
        }
        return reply.status(500).send(safeError('Failed to start session', err));
      }
    },
  );

  app.post(
    '/:id/sessions/:sessionId/cancel',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, sessionId } = request.params;
      const session = await db.getTurn(sessionId);

      if (!session || session.agentId !== id) {
        return reply.status(404).send({ error: 'Session not found', sessionId });
      }

      const cancelled = session.sessionId ? sessionManager?.cancelCurrentTurn(session.sessionId, sessionId) : false;
      if (!cancelled) {
        return reply.status(404).send({ error: 'Session not found', sessionId });
      }

      const inMemoryInterruptResolved = await interrupts.resolve(
        sessionId,
        'reject',
        'Session cancelled',
        id,
        session.conversationId ?? undefined,
      );
      if (!inMemoryInterruptResolved) {
        const dbInterrupt = await db.getPendingInterrupt(sessionId);
        if (dbInterrupt?.agentId === id && dbInterrupt.status === 'pending') {
          await db.resolveInterrupt(sessionId, 'reject', 'Session cancelled');
        }
      }

      if (eventBus) {
        eventBus.emitCustom('run_cancelled', id, {
          runId: sessionId,
          agentId: id,
          timestamp: Date.now(),
        });
      }

      return reply.send({ cancelled: true, sessionId });
    },
  );

  app.get(
    '/:id/sessions/:sessionId',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, sessionId } = request.params;

      const session = await db.getTurn(sessionId);

      if (!session || session.agentId !== id) {
        return reply.status(404).send({ error: 'Session not found', sessionId });
      }

      const conversationId = session.conversationId;
      const [messages, sandboxSession] = await Promise.all([
        typeof conversationId === 'string' ? db.getMessages(conversationId) : [],
        session.sessionId ? db.getSandboxSession(session.sessionId) : Promise.resolve(null),
      ]);

      return reply.send({
        session: toApiAgentSession(session, sandboxSession, messages.length),
        messages,
      });
    },
  );

  app.get(
    '/:id/sessions',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const [turns, sandboxSessions, conversationSummaries] = await Promise.all([
        db.getTurnsByAgent(id),
        db.getSandboxSessionsByAgent(id),
        db.getConversationSummaries(id),
      ]);
      const sandboxBySessionId = new Map(sandboxSessions.map((session) => [session.id, session]));
      const messageCountByConversationId = new Map(
        conversationSummaries.map((conversation) => [conversation.id, conversation.messageCount]),
      );

      const sessions = turns
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((turn) => toApiAgentSession(
          turn,
          turn.sessionId ? sandboxBySessionId.get(turn.sessionId) : null,
          turn.conversationId ? messageCountByConversationId.get(turn.conversationId) ?? 0 : 0,
        ));

      return reply.send({ sessions });
    },
  );

  app.get(
    '/:id/turns',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const turns = await db.getTurnsByAgent(id);
      return reply.send(turns);
    },
  );

  app.post(
    '/:id/sessions/:sessionId/suspend',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => sendLegacySandboxAdminGone(reply, 'suspend', request.params.sessionId),
  );

  app.post(
    '/:id/sandbox-sessions/:sessionId/suspend',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sessionId } = request.params;

      if (!sessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const sessions = await db.getSandboxSessionsByAgent(agent.id);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }

        // Gate: reject suspend if the owning turn is already completed
        const turn = await db.getLatestTurnForConversation(session.conversationId);
        if (turn && (turn.completedAt != null || turn.error)) {
          const status = turn.error ? 'ERROR' : 'COMPLETED';
          return reply.status(409).send({
            error: 'Session not active',
            status,
            sessionId,
          });
        }

        try {
          await sessionManager.suspendSession(sessionId, 'api_request');
        } catch {
          return reply.status(409).send({
            error: 'Session no longer active',
            status: 'UNKNOWN',
            sessionId,
          });
        }
        return reply.status(200).send({ sessionId, status: 'checkpointed' });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to suspend session', err));
      }
    },
  );

  app.post(
    '/:id/sessions/:sessionId/kill',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => sendLegacySandboxAdminGone(reply, 'kill', request.params.sessionId),
  );

  app.post(
    '/:id/sandbox-sessions/:sessionId/kill',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sessionId } = request.params;

      if (!sessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      try {
        const sessions = await db.getSandboxSessionsByAgent(agent.id);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }

        await sessionManager.killSession(sessionId);
        return reply.status(204).send();
      } catch (err) {
        return reply.status(500).send(safeError('Failed to kill session', err));
      }
    },
  );
}
