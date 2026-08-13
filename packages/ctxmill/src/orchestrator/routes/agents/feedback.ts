import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { EventMap } from '../../../events/bus.js';
import type { AgentSubRouteOptions } from './types.js';

/** Maximum accepted length for a feedback comment, in characters. */
const MAX_COMMENT_LENGTH = 4000;

export async function feedbackRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, eventBus, loadAgent } = opts;

  app.post(
    '/:id/feedback',
    { preHandler: [loadAgent], config: { capability: 'feedback:write' } },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          conversationId: string;
          messageId: string;
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
        comment?: unknown;
      } | undefined;

      if (
        !body ||
        typeof body.conversationId !== 'string' ||
        typeof body.messageId !== 'string' ||
        body.messageId.trim() === '' ||
        (body.type !== 'thumbs_up' && body.type !== 'thumbs_down')
      ) {
        return reply.status(400).send({
          error: 'conversationId, messageId, and type ("thumbs_up" or "thumbs_down") are required',
        });
      }

      if (body.comment !== undefined && typeof body.comment !== 'string') {
        return reply.status(400).send({ error: 'comment must be a string' });
      }
      const comment = typeof body.comment === 'string' ? body.comment.trim() : undefined;
      if (comment !== undefined && comment.length > MAX_COMMENT_LENGTH) {
        return reply.status(400).send({
          error: `comment must be at most ${MAX_COMMENT_LENGTH} characters`,
        });
      }

      const message = await db.getMessage(body.messageId);
      if (
        !message
        || message.agentId !== id
        || message.conversationId !== body.conversationId
        || !message.turnId
      ) {
        return reply.status(404).send({ error: 'Feedback message not found' });
      }
      const turn = await db.getTurn(message.turnId);
      if (
        !turn
        || turn.agentId !== id
        || turn.conversationId !== body.conversationId
      ) {
        return reply.status(404).send({ error: 'Feedback message not found' });
      }
      const turnId = turn.id;
      const feedbackId = randomUUID();

      const eventPayload: EventMap['feedback.received'] = {
        feedbackId,
        turnId,
        agentId: id,
        type: body.type,
        messageId: body.messageId,
        ...(comment !== undefined && comment !== '' ? { comment } : {}),
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
