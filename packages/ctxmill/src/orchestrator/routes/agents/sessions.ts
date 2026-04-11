import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { toAgentDefinition } from '../../session-manager/session-agent-definition.js';
import { mapMessagesToInternal } from '../agent-helpers.js';
import { getRequestAgent, safeError, toApiAgentSession } from './helpers.js';
import type { AgentSubRouteOptions, StoredAgent } from './types.js';

export async function sessionRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, agentSessionService, sessionManager, eventBus, runStartupService, loadAgent } = opts;

  const buildAgentDefinition = (agent: StoredAgent) => (
    runStartupService
      ? runStartupService.buildAgentDefinition(agent)
      : toAgentDefinition(agent)
  );

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

      let conversationId = body.conversationId;
      let createdConversation = false;
      if (!conversationId) {
        const conversation = await db.createConversation(id);
        conversationId = conversation.id;
        createdConversation = true;
      }

      const message = await db.addMessage({
        agentId: id,
        conversationId,
        role: 'user',
        content: body.content,
      });

      let session: Awaited<ReturnType<typeof db.createTurn>>;
      try {
        sessionManager?.checkConcurrencyLimit(id);
        session = await db.createTurn({ agentId: id, conversationId, mode: 'interactive' });
      } catch (err) {
        await db.deleteMessage(message.id).catch((deleteErr) => {
          console.error(`[agents] failed to rollback user message ${message.id}:`, deleteErr);
        });
        if (createdConversation) {
          console.error(`[agents] interactive session start failed after creating conversation ${conversationId}`);
        }
        return reply.status(500).send(safeError('Failed to start session', err));
      }

      if (eventBus) {
        eventBus.emit('user.message', {
          agentId: id,
          conversationId,
          messageId: message.id,
          content: body.content,
          timestamp: Date.now(),
        });
      }

      if (eventBus) {
        eventBus.emit('turn.pending', {
          turnId: session.id,
          agentId: id,
          conversationId,
          mode: 'interactive' as const,
          timestamp: Date.now(),
        });
      }

      if (!agent.harness) {
        return reply.status(500).send({ error: 'Agent harness is not set' });
      }
      const agentDef = buildAgentDefinition(agent);
      const allMessages = await db.getMessages(conversationId);
      const messages = mapMessagesToInternal(allMessages, id);

      void agentSessionService.executeSession({
        agentDef,
        messages,
        agentId: id,
        conversationId,
        sessionId: session.id,
        mode: 'interactive',
        taskDescription: body.content,
      }).catch(async (err) => {
        console.error(`[agents] executeSession failed for agent ${id}, session ${session.id}:`, err);
        await db.updateTurn(session.id, { completedAt: Date.now(), error: String(err) }).catch((dbErr) => {
          console.error(`[agents] Failed to update turn ${session.id} after session error:`, dbErr);
        });
      });

      return reply.status(201).send({
        messageId: message.id,
        conversationId,
        sessionId: session.id,
      });
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
      const conversation = await db.createConversation(id);
      const conversationId = conversation.id;

      sessionManager?.checkConcurrencyLimit(id);
      const session = await db.createTurn({
        agentId: id,
        conversationId,
        mode: 'background',
        taskDescription: body.task,
      });

      await db.updateAgentStatus(id, 'running');

      if (eventBus) {
        eventBus.emit('turn.pending', {
          turnId: session.id,
          agentId: id,
          conversationId,
          mode: 'background' as const,
          taskDescription: body.task,
          timestamp: Date.now(),
        });
      }

      if (!agent.harness) {
        return reply.status(500).send({ error: 'Agent harness is not set' });
      }
      const agentDef = buildAgentDefinition(agent);

      await db.addMessage({
        agentId: id,
        conversationId,
        role: 'user',
        content: body.task,
      });

      const allMessages = await db.getMessages(conversationId);
      const messages = mapMessagesToInternal(allMessages, id);

      void agentSessionService.executeSession({
        agentDef,
        messages,
        agentId: id,
        conversationId,
        sessionId: session.id,
        mode: 'background',
        taskDescription: body.task ?? 'background session',
      }).catch(async (err) => {
        console.error(`[agents] executeSession failed for agent ${id}, session ${session.id}:`, err);
        await db.updateTurn(session.id, { completedAt: Date.now(), error: String(err) }).catch((dbErr) => {
          console.error(`[agents] Failed to update turn ${session.id} after session error:`, dbErr);
        });
      });

      return reply.status(201).send({
        sessionId: session.id,
        conversationId,
      });
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

      let session = await db.getTurn(sessionId);
      if (!session) {
        const conversation = await db.getConversation(sessionId);
        if (conversation?.agentId === id) {
          session = await db.getLatestTurnForConversation(conversation.id);
        }
      }

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
