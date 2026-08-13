import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { InterruptResumeAttemptRow } from '../../../database/repository.js';
import { InterruptResumeAttemptWorker } from '../../interrupt-resume-attempt-worker.js';
import type { AgentSubRouteOptions } from './types.js';

export async function interruptRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, interrupts, sessionManager, loadAgent } = opts;
  const resumeWorker = sessionManager
    ? new InterruptResumeAttemptWorker({
        db,
        sessionManager,
        logger: app.log,
      })
    : undefined;

  if (resumeWorker) {
    app.addHook('onReady', () => {
      resumeWorker.start();
    });
    app.addHook('onClose', async () => {
      await resumeWorker.stop();
    });
  }

  const acceptResumeAttempt = async (
    reply: FastifyReply,
    attempt: InterruptResumeAttemptRow,
    action: 'approve' | 'reject',
  ) => {
    if (resumeWorker) {
      resumeWorker.enqueue(attempt);
      return reply.status(202).send({
        accepted: true,
        resuming: true,
        action,
        resumeAttemptId: attempt.id,
      });
    }

    if (attempt.status === 'pending') {
      await db.failUnclaimedInterruptResumeAttempt(
        attempt.id,
        'Session resume service is not available',
      );
    }
    return reply.status(202).send({
      accepted: true,
      resuming: false,
      action,
      resumeAttemptId: attempt.id,
      error: 'Session resume service is not available',
    });
  };

  app.get(
    '/:id/interrupts',
    { preHandler: [loadAgent], config: { capability: 'interrupts:read' } },
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
        interruptId: string;
        turnId: string;
        sandboxSessionId?: string;
        agentId: string;
        toolCallId: string;
        toolCallName: string;
        args: Record<string, unknown>;
        createdAt: number;
        status: string;
        resumeError?: string;
      }> = inMemory.map((entry) => ({
        interruptId: entry.info.interruptId,
        turnId: entry.turnId,
        ...(entry.info.sandboxSessionId ? { sandboxSessionId: entry.info.sandboxSessionId } : {}),
        agentId: id,
        toolCallId: entry.info.toolCallId,
        toolCallName: entry.info.toolCallName,
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
        const seenIds = new Set(pending.map((entry) => entry.interruptId));
        for (const { interrupt, resumeAttempt } of dbRows) {
          if (!seenIds.has(interrupt.id)) {
            pending.push({
              interruptId: interrupt.id,
              turnId: interrupt.turnId,
              ...(interrupt.sandboxSessionId ? { sandboxSessionId: interrupt.sandboxSessionId } : {}),
              agentId: interrupt.agentId,
              toolCallId: interrupt.toolCallId,
              toolCallName: interrupt.toolName,
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
    { config: { capability: 'interrupts:resolve' } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { action: 'approve' | 'reject' | 'submit'; interruptId: string; data?: unknown };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as { action?: string; interruptId?: string; data?: unknown } | undefined;

      if (
        !body ||
        (body.action !== 'approve' && body.action !== 'reject' && body.action !== 'submit') ||
        typeof body.interruptId !== 'string' ||
        body.interruptId.trim() === ''
      ) {
        return reply.status(400).send({
          error: 'action is required and must be "approve", "reject", or "submit", and interruptId is required',
        });
      }

      const resolveAction: 'approve' | 'reject' = body.action === 'submit' ? 'approve' : body.action as 'approve' | 'reject';
      const dbInterrupt = await db.getInterruptById(body.interruptId);
      const turnId = dbInterrupt?.turnId ?? interrupts.findTurnIdByInterruptId(body.interruptId);

      // Ownership (ctx-aac): a live in-memory interrupt for another agent must
      // not be resolvable through this agent's route.
      if (turnId && interrupts.hasPendingForTurn(turnId) && !interrupts.ownsPendingForTurn(turnId, id)) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      const existingResumeAttempt = dbInterrupt
        ? await db.getInterruptResumeAttemptForInterrupt(dbInterrupt.id)
        : undefined;

      if (dbInterrupt && dbInterrupt.agentId !== id) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      if (dbInterrupt && dbInterrupt.agentId === id) {
        if (dbInterrupt.status === 'resolved') {
          if (dbInterrupt.resolvedAction !== resolveAction) {
            return reply.status(409).send({
              error: 'Interrupt was already resolved with a different action',
              action: dbInterrupt.resolvedAction,
            });
          }
          if (existingResumeAttempt?.status === 'completed') {
            return reply.send({ alreadyResolved: true, action: dbInterrupt.resolvedAction });
          }
          if (
            existingResumeAttempt?.status === 'pending'
            || existingResumeAttempt?.status === 'in_progress'
          ) {
            return acceptResumeAttempt(reply, existingResumeAttempt, resolveAction);
          }
          if (existingResumeAttempt?.status === 'failed') {
            let attempt = await db.retryFailedInterruptResumeAttempt(
              existingResumeAttempt.id,
            );
            if (!attempt) {
              const current = await db.getInterruptResumeAttemptForInterrupt(dbInterrupt.id);
              if (current?.status === 'completed') {
                return reply.send({
                  alreadyResolved: true,
                  action: dbInterrupt.resolvedAction,
                });
              }
              if (current?.status === 'pending' || current?.status === 'in_progress') {
                attempt = current;
              }
            }
            if (!attempt) {
              return reply.status(409).send({
                error: 'Interrupt resume attempt is not retryable',
              });
            }
            return acceptResumeAttempt(reply, attempt, resolveAction);
          }

          // Repair rows persisted by an older process that crashed after
          // resolving the interrupt but before creating a continuation attempt.
          const repaired = await db.resolveInterruptWithResumeAttempt(
            dbInterrupt.id,
            resolveAction,
            dbInterrupt.resolvedData,
          );
          if (!repaired || repaired.kind !== 'ready') {
            return reply.status(409).send({ error: 'Interrupt is not actionable' });
          }
          if (repaired.resumeAttempt) {
            return acceptResumeAttempt(reply, repaired.resumeAttempt, resolveAction);
          }
          return reply.send({
            resolved: true,
            action: resolveAction,
            note: 'Resolved in DB; session resume not available',
          });
        }
      }

      // A rehydrated entry (post-restart) resolves in memory too, but its
      // promise has no live waiter — that resolution must fall through to the
      // durable continuation below instead of returning early (ctx-8nnu).
      const hadLiveWaiter = turnId ? interrupts.hasLiveWaiterForTurn(turnId) : false;
      const inMemoryResolved = hadLiveWaiter && turnId
        ? await interrupts.resolveForTurn(turnId, resolveAction, body.data, id)
        : false;

      if (!dbInterrupt && !inMemoryResolved) {
        return reply.status(404).send({ error: 'No pending interrupt for agent', agentId: id });
      }

      if (inMemoryResolved && hadLiveWaiter) {
        return reply.send({ resolved: true, action: resolveAction });
      }

      // Durable continuation for approve AND reject (ctx-qjnz): with no live
      // waiter, the foreground turn can only make progress via a durable
      // resume that delivers the APPROVED/REJECTED continuation.
      if (dbInterrupt) {
        const durableResolution = await db.resolveInterruptWithResumeAttempt(
          dbInterrupt.id,
          resolveAction,
          body.data,
        );
        if (!durableResolution) {
          return reply.status(409).send({
            error: 'Interrupt is not actionable',
            status: dbInterrupt.status,
          });
        }
        if (durableResolution.kind === 'conflict') {
          return reply.status(409).send({
            error: 'Interrupt was already resolved with a different action',
            action: durableResolution.interrupt.resolvedAction,
          });
        }
        if (turnId && interrupts.hasPendingForTurn(turnId)) {
          await interrupts.settlePersistedResolutionForTurn(
            turnId,
            dbInterrupt.id,
            resolveAction,
            body.data,
            id,
          );
        }
        if (durableResolution.resumeAttempt) {
          return acceptResumeAttempt(
            reply,
            durableResolution.resumeAttempt,
            resolveAction,
          );
        }
      }

      return reply.send({ resolved: true, action: resolveAction, note: 'Resolved in DB; session resume not available' });
    },
  );
}
