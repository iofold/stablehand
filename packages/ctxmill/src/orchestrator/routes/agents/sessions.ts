import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  ActiveTurnSuspendError,
  RestoreConflictError,
  SandboxSessionNotFoundError,
} from '../../session-manager/session-lifecycle-service.js';
import { classifyRestoreFailure } from '../../session-manager/restore-retry-policy.js';
import type { RuntimeSandboxSecrets } from '../../session-manager/runtime-sandbox-secrets.js';
import { SESSION_CANCELLED_MESSAGE, isSessionCancelled } from '../../session-cancellation.js';
import { TurnFinalizer } from '../../turn-finalizer.js';
import { buildAgentDefinition } from '../../agent-definition.js';
import { sendRunStartError } from '../../run-start-errors.js';
import { getRequestAgent, safeError, toApiAgentSession } from './helpers.js';
import type { AgentSubRouteOptions } from './types.js';
import type { SandboxSessionRow } from '../../../database/repository.js';

async function loadOwnedSandboxSession(
  db: Pick<AgentSubRouteOptions['db'], 'getSandboxSession'>,
  agentId: string,
  sessionId: string,
): Promise<SandboxSessionRow | null> {
  const session = await db.getSandboxSession(sessionId);
  return session?.agentId === agentId ? session : null;
}

export async function sessionRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, interrupts, sessionManager, eventBus, runStartupService, loadAgent } = opts;
  const turnFinalizer = new TurnFinalizer({ db, eventBus, logger: console });

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

  app.post(
    '/:id/message',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { content: string; conversationId?: string; sandboxSecrets?: Record<string, string> };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { content: string; conversationId?: string; sandboxSecrets?: unknown };

      if (!body || typeof body.content !== 'string' || body.content.trim() === '') {
        return reply.status(400).send({ error: 'content is required and must be a non-empty string' });
      }

      const agent = getRequestAgent(request);

      try {
        const sandboxSecrets = parseSandboxSecrets(body.sandboxSecrets);
        const start = await runStartupService.prepareRunStart({
          agent,
          agentId: id,
          content: body.content,
          mode: 'interactive',
          conversationId: body.conversationId,
          emitUserMessageEvent: true,
          sandboxSecrets,
        });
        void runStartupService.launchPreparedRun(start, id);
        return reply.status(201).send({
          messageId: start.messageId,
          conversationId: start.conversationId,
          sessionId: start.turnId,
        });
      } catch (err) {
        if (sendRunStartError(reply, err)) return reply;
        if (err instanceof Error && err.message.startsWith('Conversation ')) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof Error && /sandbox secret|sandboxSecrets/i.test(err.message)) {
          return reply.status(400).send({ error: err.message });
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
        const start = await runStartupService.prepareRunStart({
          agent,
          agentId: id,
          content: body.task,
          mode: 'background',
          emitUserMessageEvent: false,
          sandboxSecrets,
        });
        void runStartupService.launchPreparedRun(start, id);
        return reply.status(201).send({
          sessionId: start.turnId,
          conversationId: start.conversationId,
          sandboxSessionId: null,  // populated asynchronously; poll GET /:id/sessions/:sessionId until non-null to get the id required by /sandbox-sessions/:id/suspend
        });
      } catch (err) {
        if (sendRunStartError(reply, err)) return reply;
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

      if (session.completedAt != null) {
        return reply.send({
          cancelled: isSessionCancelled(session.error),
          sessionId,
          alreadyTerminal: true,
        });
      }

      const cancelled = session.sessionId ? sessionManager?.cancelCurrentTurn(session.sessionId, sessionId) : false;
      if (!cancelled) {
        await turnFinalizer.finalize({
          turnId: sessionId,
          agentId: id,
          conversationId: session.conversationId ?? '',
          ...(session.sessionId ? { sessionId: session.sessionId } : {}),
          status: 'cancelled',
          error: SESSION_CANCELLED_MESSAGE,
          durationMs: Date.now() - session.startedAt,
        });
      }

      const inMemoryInterruptResolved = await interrupts.resolve(
        sessionId,
        'reject',
        SESSION_CANCELLED_MESSAGE,
        id,
        session.conversationId ?? undefined,
      );
      if (!inMemoryInterruptResolved) {
        const dbInterrupt = await db.getPendingInterrupt(sessionId);
        if (dbInterrupt?.agentId === id && dbInterrupt.status === 'pending') {
          await db.resolveInterrupt(sessionId, 'reject', SESSION_CANCELLED_MESSAGE);
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
        const session = await loadOwnedSandboxSession(db, agent.id, sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }

        // Gate on the sandbox row, not the latest turn (ctx-jgb5): an idle
        // ACTIVE sandbox after a completed turn is suspendable. A mid-turn
        // suspend is rejected below via ActiveTurnSuspendError.
        if (session.status !== 'ACTIVE') {
          return reply.status(409).send({
            error: 'Session not active',
            status: session.status,
            sessionId,
          });
        }

        try {
          await sessionManager.suspendSession(sessionId, 'api_request');
        } catch (err) {
          if (err instanceof ActiveTurnSuspendError) {
            return reply.status(409).send({
              error: 'Session has active turn',
              status: 'ACTIVE',
              sessionId,
              turnId: err.turnId,
            });
          }
          const current = await db.getSandboxSession(sessionId);
          return reply.status(409).send({
            error: 'Session no longer active',
            status: current?.status ?? 'TERMINATED',
            sessionId,
          });
        }
        return reply.status(200).send({ sessionId, status: 'CHECKPOINTED' });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to suspend session', err));
      }
    },
  );

  app.post(
    '/:id/sandbox-sessions/:sessionId/restore',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string; sessionId: string };
        Querystring: { async?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const agent = getRequestAgent(request);
      const { sessionId } = request.params;
      const startAsync = request.query.async === 'true' || request.query.async === '1';

      if (!sessionManager) {
        return reply.status(501).send({ error: 'Sandbox session manager not configured' });
      }

      const session = await loadOwnedSandboxSession(db, agent.id, sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found', sessionId });
      }

      if (session.status !== 'CHECKPOINTED') {
        return reply.status(409).send({
          error: 'Session not checkpointed',
          status: session.status,
          sessionId,
        });
      }

      try {
        if (startAsync) {
          const restore = await sessionManager.restoreSession(
            sessionId,
            buildAgentDefinition(agent),
            agent.id,
            { background: true },
          );
          return reply.status(202).send(restore);
        }

        const restored = await sessionManager.restoreSession(sessionId, buildAgentDefinition(agent), agent.id);
        return reply.status(200).send({
          sessionId: restored.sessionId,
          status: restored.status,
          restoreAttempts: 0,
        });
      } catch (err) {
        if (err instanceof SandboxSessionNotFoundError) {
          return reply.status(404).send({ error: 'Session not found', sessionId });
        }
        if (err instanceof RestoreConflictError) {
          return reply.status(409).send({
            error: 'Session not checkpointed',
            status: err.status,
            sessionId,
          });
        }

        const classification = classifyRestoreFailure(err);
        const current = await db.getSandboxSession(sessionId);
        return reply.status(502).send({
          error: 'Restore failed',
          code: 'restore_failed',
          category: classification.category,
          detail: classification.message,
          status: current?.status ?? 'TERMINATED',
          restoreAttempts: current?.restoreAttempts ?? null,
          sessionId,
        });
      }
    },
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
        const session = await loadOwnedSandboxSession(db, agent.id, sessionId);
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
