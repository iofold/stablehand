import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AgentSubRouteOptions } from './types.js';

export async function knowledgeRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { knowledgeStore, loadAgent } = opts;

  app.get(
    '/:id/knowledge/stats',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;

      if (!knowledgeStore) {
        return reply.send({ totalItems: 0, categories: {}, recentItems: 0 });
      }

      const stats = await knowledgeStore.stats(id);
      return reply.send(stats);
    },
  );

  app.get(
    '/:id/knowledge/:itemId',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; itemId: string } }>,
      reply: FastifyReply,
    ) => {
      const { id, itemId } = request.params;

      if (!knowledgeStore) {
        return reply.status(404).send({ error: 'Knowledge item not found', itemId });
      }

      const item = await knowledgeStore.get(itemId);
      if (!item || item.agentId !== id) {
        return reply.status(404).send({ error: 'Knowledge item not found', itemId });
      }

      return reply.send(item);
    },
  );

  app.get(
    '/:id/knowledge',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Querystring: { q?: string; category?: string; limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const query = request.query as { q?: string; category?: string; limit?: string; offset?: string };

      if (!knowledgeStore) {
        return reply.send({ items: [], total: 0 });
      }

      const result = await knowledgeStore.search(id, {
        q: query.q,
        category: query.category,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      const items = result.items.map((item) => ({
        id: item.id,
        content: item.content,
        category: item.category,
        source: item.source,
        createdAt: item.createdAt,
        relevance: item.effectiveness,
      }));

      return reply.send({ items, total: result.total });
    },
  );
}
