import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { KnowledgeStore } from '../../knowledge/types.js';

/** Plugin options for the shared-knowledge routes. */
export interface KnowledgeRouteOptions {
  knowledgeStore?: KnowledgeStore;
}

/**
 * Shared knowledge routes — mounted at /api/knowledge.
 *
 * These provide cross-agent knowledge operations that are separate from the
 * per-agent knowledge endpoints in agents.ts.
 */
export async function knowledgeRoutes(
  app: FastifyInstance,
  opts: KnowledgeRouteOptions,
): Promise<void> {
  const { knowledgeStore } = opts;

  // ── GET /api/knowledge/shared — List shared knowledge items ────────

  app.get(
    '/shared',
    async (
      request: FastifyRequest<{
        Querystring: { q?: string; category?: string; limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!knowledgeStore) {
        return reply.send({ items: [], total: 0 });
      }

      const query = request.query as { q?: string; category?: string; limit?: string; offset?: string };

      if (query.q || query.category) {
        const result = await knowledgeStore.searchShared({
          q: query.q,
          category: query.category,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
          offset: query.offset ? parseInt(query.offset, 10) : undefined,
        });

        const items = result.items.map(toApiItem);
        return reply.send({ items, total: result.total });
      }

      const allItems = await knowledgeStore.listShared();
      const items = allItems.map(toApiItem);
      return reply.send({ items, total: items.length });
    },
  );

  // ── GET /api/knowledge/shared/stats — Shared knowledge stats ──────

  app.get(
    '/shared/stats',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!knowledgeStore) {
        return reply.send({ totalItems: 0, categories: {}, recentItems: 0 });
      }

      const stats = await knowledgeStore.sharedStats();
      return reply.send(stats);
    },
  );

  // ── POST /api/knowledge/shared — Add shared knowledge item ────────

  app.post(
    '/shared',
    async (
      request: FastifyRequest<{
        Body: { content: string; category?: string; source?: string; effectiveness?: number };
      }>,
      reply: FastifyReply,
    ) => {
      if (!knowledgeStore) {
        return reply.status(503).send({ error: 'Knowledge store not available' });
      }

      const { content, category, source, effectiveness } = request.body as {
        content: string;
        category?: string;
        source?: string;
        effectiveness?: number;
      };

      if (!content || typeof content !== 'string') {
        return reply.status(400).send({ error: 'content is required' });
      }

      const item = await knowledgeStore.addShared({
        content,
        category: category || 'general',
        source: source || 'human',
        effectiveness: effectiveness ?? 0,
      });

      return reply.status(201).send(toApiItem(item));
    },
  );

  // ── DELETE /api/knowledge/shared/:itemId — Remove shared item ─────

  app.delete(
    '/shared/:itemId',
    async (
      request: FastifyRequest<{ Params: { itemId: string } }>,
      reply: FastifyReply,
    ) => {
      if (!knowledgeStore) {
        return reply.status(503).send({ error: 'Knowledge store not available' });
      }

      const { itemId } = request.params;

      const item = await knowledgeStore.get(itemId);
      if (!item) {
        return reply.status(404).send({ error: 'Knowledge item not found', itemId });
      }

      await knowledgeStore.remove(itemId);
      return reply.send({ ok: true });
    },
  );

  // ── GET /api/knowledge/search — Cross-agent semantic search ───────

  app.get(
    '/search',
    async (
      request: FastifyRequest<{
        Querystring: { q?: string; category?: string; limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      if (!knowledgeStore) {
        return reply.send({ items: [], total: 0 });
      }

      const query = request.query as { q?: string; category?: string; limit?: string; offset?: string };

      const result = await knowledgeStore.searchAll({
        q: query.q,
        category: query.category,
        limit: query.limit ? parseInt(query.limit, 10) : undefined,
        offset: query.offset ? parseInt(query.offset, 10) : undefined,
      });

      const items = result.items.map(toApiItem);
      return reply.send({ items, total: result.total });
    },
  );
}

/** Map internal KnowledgeItem to the API response shape. */
function toApiItem(item: { id: string; content: string; category: string; source: string; effectiveness: number; createdAt: Date; agentId: string }) {
  return {
    id: item.id,
    agentId: item.agentId,
    content: item.content,
    category: item.category,
    source: item.source,
    createdAt: item.createdAt,
    relevance: item.effectiveness,
  };
}
