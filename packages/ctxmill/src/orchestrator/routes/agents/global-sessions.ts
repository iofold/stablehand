import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SessionsRouteOptions } from './types.js';

export async function globalSessionsRoutes(
  app: FastifyInstance,
  opts: SessionsRouteOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/', async (
    request: FastifyRequest<{ Querystring: { format?: string } }>,
    reply: FastifyReply,
  ) => {
    const { format } = request.query;
    if (format === 'sandbox') {
      const activeSessions = await db.getActiveSandboxSessions();
      return reply.send(activeSessions);
    }

    const activeConversations = await db.getActiveConversationSummaries();
    return reply.send(activeConversations);
  });
}
