import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AgentSubRouteOptions } from './types.js';

export async function versionRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, loadAgent } = opts;

  app.get(
    '/:id/versions',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const versions = await db.getAgentVersions(id);
      return reply.send({ versions });
    },
  );
}
