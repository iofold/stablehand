import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AgentSubRouteOptions } from './types.js';

export async function interruptRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, interrupts, sessionManager, eventBus, loadAgent } = opts;

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

      const inMemory = interrupts.getPendingForAgent(id);
      const pending = inMemory.map((entry) => ({
        id: entry.turnId,
        sessionId: entry.turnId,
        agentId: id,
        toolCallId: entry.info.toolCallId,
        toolName: entry.info.toolName,
        args: entry.info.args,
        createdAt: entry.info.createdAt,
        status: 'pending' as const,
      }));

      if (includeResolved) {
        try {
          const dbRows = await db.getPendingInterruptsForAgent(id);
          const seenIds = new Set(pending.map((p) => p.id));
          for (const row of dbRows) {
            if (!seenIds.has(row.id)) {
              pending.push({
                id: row.id,
                sessionId: row.agentSessionId,
                agentId: row.agentId,
                toolCallId: row.toolCallId,
                toolName: row.toolName,
                args: row.args as Record<string, unknown>,
                createdAt: row.createdAt,
                status: row.status as 'pending',
              });
            }
          }
        } catch (err) {
          request.log.warn({ err }, 'Failed to load resolved interrupts');
        }
      }

      return reply.send({ interrupts: pending });
    },
  );

  app.post(
    '/:id/interrupt',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { action: 'approve' | 'reject' | 'submit'; sessionId: string; data?: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { action?: string; sessionId?: string; data?: unknown } | undefined;

      if (
        !body ||
        (body.action !== 'approve' && body.action !== 'reject' && body.action !== 'submit') ||
        typeof body.sessionId !== 'string' ||
        body.sessionId.trim() === ''
      ) {
        return reply.status(400).send({
          error: 'action is required and must be "approve", "reject", or "submit", and sessionId is required',
        });
      }

      const resolveAction: 'approve' | 'reject' = body.action === 'submit' ? 'approve' : body.action as 'approve' | 'reject';

      const dbInterrupt = await db.getPendingInterrupt(body.sessionId);

      if (dbInterrupt && dbInterrupt.agentId === id) {
        if (dbInterrupt.status === 'resolved') {
          return reply.send({ alreadyResolved: true, action: dbInterrupt.resolvedAction });
        }

        await db.resolveInterrupt(body.sessionId, resolveAction, body.data);
      }

      const inMemoryResolved = interrupts.resolve(body.sessionId, resolveAction, body.data, id);

      if (!dbInterrupt && !inMemoryResolved) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }
      if (dbInterrupt && dbInterrupt.agentId !== id && !inMemoryResolved) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      if (inMemoryResolved) {
        if (eventBus) {
          eventBus.emit('run.interrupt_resolved', {
            turnId: dbInterrupt?.agentSessionId ?? body.sessionId,
            agentId: id,
            interruptId: dbInterrupt?.id ?? body.sessionId,
            action: resolveAction as 'approve' | 'reject' | 'suspend' | 'timeout',
            timestamp: Date.now(),
          });
        }
        return reply.send({ resolved: true, action: resolveAction });
      }

      const sessionId = dbInterrupt?.sessionId;
      if (sessionId && dbInterrupt && sessionManager?.resumeWithInterruptResolution) {
        void sessionManager.resumeWithInterruptResolution(sessionId, dbInterrupt.agentSessionId, id).catch((err) => {
          console.error(`[agents] async resume failed for session ${sessionId}:`, err);
        });

        if (eventBus) {
          eventBus.emit('run.interrupt_resolved', {
            turnId: dbInterrupt.agentSessionId,
            agentId: id,
            interruptId: dbInterrupt.id,
            action: resolveAction as 'approve' | 'reject' | 'suspend' | 'timeout',
            timestamp: Date.now(),
          });
        }

        return reply.status(202).send({ accepted: true, resuming: true, action: resolveAction });
      }

      if (eventBus) {
        eventBus.emit('run.interrupt_resolved', {
          turnId: dbInterrupt?.agentSessionId ?? '',
          agentId: id,
          interruptId: dbInterrupt?.id ?? body.sessionId,
          action: resolveAction as 'approve' | 'reject' | 'suspend' | 'timeout',
          timestamp: Date.now(),
        });
      }

      return reply.send({ resolved: true, action: resolveAction, note: 'Resolved in DB; session resume not available' });
    },
  );
}
