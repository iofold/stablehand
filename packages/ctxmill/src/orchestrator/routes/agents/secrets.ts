import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { safeError } from './helpers.js';
import type { AgentSubRouteOptions } from './types.js';

export async function secretRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { secretProvider, loadAgent } = opts;

  app.get(
    '/:id/secrets',
    { preHandler: [loadAgent] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!secretProvider) {
        return reply.status(501).send({ error: 'Secret storage not configured' });
      }
      try {
        const keys = await secretProvider.list(request.params.id);
        return reply.send({ keys });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to list secrets', err));
      }
    },
  );

  app.post(
    '/:id/secrets',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { key: string; value: string } }>,
      reply: FastifyReply,
    ) => {
      if (!secretProvider) {
        return reply.status(501).send({ error: 'Secret storage not configured' });
      }
      const { key, value } = request.body ?? ({} as Record<string, string>);
      if (!key || typeof key !== 'string' || !value || typeof value !== 'string') {
        return reply.status(400).send({ error: 'key and value are required strings' });
      }
      try {
        await secretProvider.set(request.params.id, key, value);
        return reply.status(201).send({ key });
      } catch (err) {
        return reply.status(500).send(safeError('Failed to set secret', err));
      }
    },
  );

  app.delete(
    '/:id/secrets/:key',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string; key: string } }>,
      reply: FastifyReply,
    ) => {
      if (!secretProvider) {
        return reply.status(501).send({ error: 'Secret storage not configured' });
      }
      try {
        await secretProvider.delete(request.params.id, request.params.key);
        return reply.status(204).send();
      } catch (err) {
        return reply.status(500).send(safeError('Failed to delete secret', err));
      }
    },
  );
}
