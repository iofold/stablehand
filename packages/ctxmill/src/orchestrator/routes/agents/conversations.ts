import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AgentSubRouteOptions } from './types.js';

export async function conversationRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, loadAgent } = opts;

  app.get(
    '/:id/conversations',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const conversations = await db.getConversationsForAgent(id);
      return reply.send(conversations);
    },
  );

  app.get(
    '/:id/conversations/summary',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      const conversations = await db.getConversationSummaries(id);
      return reply.send({ conversations });
    },
  );

  app.get(
    '/:id/conversations/:convId/messages',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; convId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, convId } = request.params;

      const conversation = await db.getConversation(convId);
      if (!conversation || conversation.agentId !== id) {
        return reply.status(404).send({ error: 'Conversation not found' });
      }

      const messages = await db.getMessages(convId);
      return reply.send(messages);
    },
  );
}
