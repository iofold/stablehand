import type { FastifyInstance } from 'fastify';
import type { DatabaseRepository } from '../../database/repository.js';

export interface EventRouteOptions {
  db: DatabaseRepository;
}

/**
 * Event log API routes.
 * Provides paginated event history and aggregate statistics.
 */
export async function eventRoutes(
  app: FastifyInstance,
  opts: EventRouteOptions,
): Promise<void> {
  const { db } = opts;

  // GET /api/events — paginated event list with optional filters
  app.get('/', async (request) => {
    const query = request.query as {
      cursor?: string;
      limit?: string;
      type?: string;
      agentId?: string;
      turnId?: string;
      conversationId?: string;
      since?: string;
    };

    const cursor = query.cursor ? Number(query.cursor) : undefined;
    const limit = Math.min(Number(query.limit) || 50, 200);
    const since = query.since ? Number(query.since) : undefined;

    const events = await db.getEvents({
      cursor,
      limit: limit + 1, // fetch one extra to determine if there's a next page
      type: query.type,
      agentId: query.agentId,
      turnId: query.turnId,
      conversationId: query.conversationId,
      since,
    });

    const hasMore = events.length > limit;
    const page = hasMore ? events.slice(0, limit) : events;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.seq : undefined;

    return {
      events: page.map((e) => ({
        ...e,
        payload: typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload),
      })),
      nextCursor,
    };
  });

  // GET /api/events/stats — aggregate event statistics
  app.get('/stats', async (request) => {
    const query = request.query as { range?: string };

    let since: number | undefined;
    switch (query.range) {
      case '1h':
        since = Date.now() - 60 * 60 * 1000;
        break;
      case '7d':
        since = Date.now() - 7 * 24 * 60 * 60 * 1000;
        break;
      case '24h':
      default:
        since = Date.now() - 24 * 60 * 60 * 1000;
        break;
    }

    return db.getEventStats(since);
  });

  // GET /api/events/types — distinct event types
  app.get('/types', async () => {
    const types = await db.getEventTypes();
    return { types };
  });
}
