import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { EventMap } from '../../../events/bus.js';
import type { AgentSubRouteOptions } from './types.js';

export async function feedbackRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, eventBus, loadAgent } = opts;

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

      const allTurns = await db.getTurnsByAgent(id);
      const matchingTurn = allTurns
        .filter((turn) => turn.conversationId === body.conversationId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const turnId = matchingTurn?.id ?? body.conversationId;
      const feedbackId = randomUUID();

      const eventPayload: EventMap['feedback.received'] = {
        feedbackId,
        turnId,
        agentId: id,
        type: body.type,
        messageId: body.messageId,
        timestamp: Date.now(),
      };

      await eventBus?.emitAsync('feedback.received', eventPayload);

      return reply.status(201).send({
        feedbackId,
        type: body.type,
        turnId,
      });
    },
  );
}
