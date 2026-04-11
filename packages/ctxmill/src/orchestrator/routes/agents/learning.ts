import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { EventMap } from '../../../events/bus.js';
import { TraceCollector } from '../../../learning/trace.js';
import { getErrorMessage } from '../../../util/errors.js';
import type { AgentSubRouteOptions } from './types.js';

export async function learningRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, learningPipeline, eventBus, loadAgent } = opts;

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

      const feedbackId = randomUUID();

      const allSessions = await db.getTurnsByAgent(id);
      const matchingSession = allSessions
        .filter((session) => session.conversationId === body.conversationId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const resolvedTurnId = matchingSession?.id ?? body.conversationId!;

      if (eventBus) {
        eventBus.emit('feedback.received', {
          feedbackId,
          turnId: resolvedTurnId,
          agentId: id,
          type: body.type as 'thumbs_up' | 'thumbs_down',
          messageId: body.messageId ?? undefined,
          timestamp: Date.now(),
        } as unknown as EventMap['feedback.received']);
      }

      const feedback = await db.saveFeedback({
        id: feedbackId,
        traceId: resolvedTurnId,
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

      if (learningPipeline) {
        try {
          const messages = await db.getMessages(body.conversationId!);
          const userMsg = messages.find((m) => m.role === 'user');
          const trace = new TraceCollector(
            id,
            resolvedTurnId,
            userMsg?.content ?? 'feedback-triggered',
          ).finalize(body.type === 'thumbs_up' ? 'success' : 'failure');

          const feedbackSignal = {
            id: feedbackId,
            traceId: resolvedTurnId,
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
}
