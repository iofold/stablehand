import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AgentSubRouteOptions } from './types.js';

export async function interruptRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, interrupts, sessionManager, loadAgent } = opts;

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
      const pending: Array<{
        id: string;
        sessionId: string;
        agentId: string;
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        createdAt: number;
        status: string;
        resumeError?: string;
      }> = inMemory.map((entry) => ({
        id: entry.turnId,
        sessionId: entry.turnId,
        agentId: id,
        toolCallId: entry.info.toolCallId,
        toolName: entry.info.toolName,
        args: entry.info.args,
        createdAt: entry.info.createdAt,
        status: 'pending' as const,
      }));

      try {
        const actionableInterrupts = await db.getActionableInterruptsForAgent(id);
        const dbRows = includeResolved
          ? actionableInterrupts
          : actionableInterrupts.filter(({ interrupt, resumeAttempt }) =>
              interrupt.status !== 'resolved' || resumeAttempt?.status === 'failed',
            );
        const seenIds = new Set(pending.map((p) => p.id));
        for (const { interrupt, resumeAttempt } of dbRows) {
          if (!seenIds.has(interrupt.id)) {
            pending.push({
              id: interrupt.id,
              sessionId: interrupt.agentSessionId,
              agentId: interrupt.agentId,
              toolCallId: interrupt.toolCallId,
              toolName: interrupt.toolName,
              args: interrupt.args as Record<string, unknown>,
              createdAt: interrupt.createdAt,
              status: resumeAttempt?.status === 'failed' ? 'resume_failed' : interrupt.status as 'pending',
              ...(resumeAttempt?.lastError ? { resumeError: resumeAttempt.lastError } : {}),
            });
          }
        }
      } catch (err) {
        request.log.warn({ err }, 'Failed to load durable interrupts');
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

      // Ownership (ctx-aac): a live in-memory interrupt for another agent must
      // not be resolvable through this agent's route.
      if (interrupts.hasPending(body.sessionId) && !interrupts.ownsPending(body.sessionId, id)) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      const dbInterrupt = await db.getPendingInterrupt(body.sessionId);
      const existingResumeAttempt = dbInterrupt
        ? await db.getInterruptResumeAttemptForInterrupt(dbInterrupt.id)
        : undefined;

      if (dbInterrupt && dbInterrupt.agentId !== id) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      if (dbInterrupt && dbInterrupt.agentId === id) {
        if (dbInterrupt.status === 'resolved') {
          // Failed durable resumes are retriable via re-POST for both actions (ctx-qjnz).
          if (existingResumeAttempt?.status !== 'failed') {
            return reply.send({ alreadyResolved: true, action: dbInterrupt.resolvedAction });
          }
        }
      }

      // A rehydrated entry (post-restart) resolves in memory too, but its
      // promise has no live waiter — that resolution must fall through to the
      // durable continuation below instead of returning early (ctx-8nnu).
      const hadLiveWaiter = interrupts.hasLiveWaiter(body.sessionId);
      const inMemoryResolved = dbInterrupt?.status === 'pending' || !dbInterrupt
        ? await interrupts.resolve(body.sessionId, resolveAction, body.data, id)
        : false;
      // interrupts.resolve() already persisted the resolution; calling
      // db.resolveInterrupt again here would 409 on the resolved row.
      const dbResolved = dbInterrupt?.status === 'resolved' && existingResumeAttempt?.status === 'failed'
        ? dbInterrupt
        : inMemoryResolved
        ? dbInterrupt
        : dbInterrupt
        ? await db.resolveInterrupt(body.sessionId, resolveAction, body.data)
        : undefined;

      if (!dbInterrupt && !inMemoryResolved) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      if (inMemoryResolved && hadLiveWaiter) {
        return reply.send({ resolved: true, action: resolveAction });
      }

      const sessionId = dbInterrupt?.sessionId;
      if (!dbResolved && dbInterrupt) {
        return reply.status(409).send({ error: 'Interrupt is not actionable', status: dbInterrupt.status });
      }

      // Durable continuation for approve AND reject (ctx-qjnz): with no live
      // waiter, the foreground turn can only make progress via a durable
      // resume that delivers the APPROVED/REJECTED continuation.
      if (sessionId && dbInterrupt) {
        const attempt = await db.upsertInterruptResumeAttempt({
          interruptId: dbInterrupt.id,
          agentSessionId: dbInterrupt.agentSessionId,
          sessionId,
          agentId: id,
          status: 'pending',
        });

        if (sessionManager?.resumeWithInterruptResolution) {
          void (async () => {
            await db.markInterruptResumeAttemptInProgress(attempt.id);
            try {
              await sessionManager.resumeWithInterruptResolution(sessionId, dbInterrupt.agentSessionId, id);
              await db.markInterruptResumeAttemptCompleted(attempt.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              await db.markInterruptResumeAttemptFailed(attempt.id, message);
              console.error(`[agents] async resume failed for session ${sessionId}:`, err);
            }
          })();

          return reply.status(202).send({ accepted: true, resuming: true, action: resolveAction, resumeAttemptId: attempt.id });
        }

        await db.markInterruptResumeAttemptFailed(attempt.id, 'Session resume service is not available');
        return reply.status(202).send({
          accepted: true,
          resuming: false,
          action: resolveAction,
          resumeAttemptId: attempt.id,
          error: 'Session resume service is not available',
        });
      }

      return reply.send({ resolved: true, action: resolveAction, note: 'Resolved in DB; session resume not available' });
    },
  );
}
