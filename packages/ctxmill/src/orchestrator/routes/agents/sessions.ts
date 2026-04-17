import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { toAgentDefinition } from '../../session-manager/session-agent-definition.js';
import { mapMessagesToInternal } from '../agent-helpers.js';
import { getRequestAgent, safeError, toApiAgentSession } from './helpers.js';
import type { AgentSubRouteOptions, StoredAgent } from './types.js';

// Session/conversation/run ID semantics are documented in
// docs/contracts/session-identity.md. In particular, the `sessionId` returned
// by message/session creation routes is the turn/run id, not the persistent
// sandbox session id.
export async function sessionRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, agentSessionService, sessionManager, eventBus, runStartupService, loadAgent } = opts;

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
    },
  ) => {
    if (runStartupService) {
      return runStartupService.prepareRunStart({
        agent,
        agentId,
        content,
        mode,
        conversationId: options?.conversationId,
        requestedTurnId: options?.requestedTurnId,
        requireExistingConversation: options?.requireExistingConversation,
        emitUserMessageEvent: options?.emitUserMessageEvent,
      });
    }

    const agentDef = toAgentDefinition(agent);
    let conversationId: string;
    if (options?.conversationId) {
      const conversation = await db.getConversation(options.conversationId);
      if (!conversation || conversation.agentId !== agentId) {
        throw new Error(`Conversation ${options.conversationId} not found for agent ${agentId}`);
      }
      conversationId = conversation.id;
    } else {
      conversationId = (await db.createConversation(agentId)).id;
    }
    const message = await db.addMessage({
      agentId,
      conversationId,
      role: 'user',
      content,
    });
    sessionManager?.checkConcurrencyLimit(agentId);
    const session = await db.createTurn({
      agentId,
      conversationId,
      mode,
      ...(mode === 'background' ? { taskDescription: content } : {}),
    });
    if (options?.emitUserMessageEvent !== false && eventBus) {
      eventBus.emit('user.message', {
        agentId,
        conversationId,
        messageId: message.id,
        content,
        timestamp: Date.now(),
      });
    }
    eventBus?.emit('turn.pending', {
      turnId: session.id,
      agentId,
      conversationId,
      mode,
      ...(mode === 'background' ? { taskDescription: content } : {}),
      timestamp: Date.now(),
    });
    const allMessages = await db.getMessages(conversationId);

    return {
      agentDef,
      conversationId,
      turnId: session.id,
      messageId: message.id,
      messages: mapMessagesToInternal(allMessages, agentId),
      mode,
      taskDescription: content,
    };
  };

  const launchPreparedRun = (
    agentId: string,
    start: Awaited<ReturnType<typeof prepareRunStart>>,
  ) => {
    if (runStartupService) {
      void runStartupService.launchPreparedRun(start, agentId).catch((err) => {
        console.error(`[agents] executeSession failed for agent ${agentId}, session ${start.turnId}:`, err);
      });
      return;
    }

    void agentSessionService.executeSession({
      agentDef: start.agentDef,
      messages: start.messages,
      agentId,
      conversationId: start.conversationId,
      sessionId: start.turnId,
      mode: start.mode,
      taskDescription: start.taskDescription,
    }).catch(async (err) => {
      console.error(`[agents] executeSession failed for agent ${agentId}, session ${start.turnId}:`, err);
      await db.updateTurn(start.turnId, { completedAt: Date.now(), error: String(err) }).catch((dbErr) => {
        console.error(`[agents] Failed to update turn ${start.turnId} after session error:`, dbErr);
      });
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
      try {
        const start = await prepareRunStart(agent, id, body.task, 'background', {
          emitUserMessageEvent: false,
        });
        await db.updateAgentStatus(id, 'running');
        launchPreparedRun(id, start);
        return reply.status(201).send({
          sessionId: start.turnId,
          conversationId: start.conversationId,
        });
      } catch (err) {
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

      const cancelled = session.sessionId ? sessionManager?.cancelCurrentTurn(session.sessionId) : false;
      if (!cancelled) {
        return reply.status(404).send({ error: 'Session not found', sessionId });
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
      const messages = typeof conversationId === 'string' ? await db.getMessages(conversationId) : [];
      return reply.send({ session, messages });
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

      const [turns, sandboxSessions] = await Promise.all([
        db.getTurnsByAgent(id),
        db.getSandboxSessionsByAgent(id),
      ]);
      const sandboxBySessionId = new Map(sandboxSessions.map((session) => [session.id, session]));

      const sessions = turns
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((turn) => toApiAgentSession(turn, turn.sessionId ? sandboxBySessionId.get(turn.sessionId) : null));

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
    ) => reply.status(410).send({
      error: 'Legacy session admin route removed. Use /api/agents/:id/sandbox-sessions/:sessionId/suspend.',
      sessionId: request.params.sessionId,
    }),
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

        await sessionManager.suspendSession(sessionId, 'api_request');
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
    ) => reply.status(410).send({
      error: 'Legacy session admin route removed. Use /api/agents/:id/sandbox-sessions/:sessionId/kill.',
      sessionId: request.params.sessionId,
    }),
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
