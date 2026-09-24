import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  SecretListResponseSchema,
  SecretPutInputSchema,
  SecretPutResponseSchema,
} from '@stablehand/contracts';

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
        return reply.send(SecretListResponseSchema.parse({ keys }));
      } catch (err) {
        return reply.status(500).send(safeError('Failed to list secrets', err));
      }
    },
  );

  app.post(
    '/:id/secrets',
    { preHandler: [loadAgent] },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
      reply: FastifyReply,
    ) => {
      if (!secretProvider) {
        return reply.status(501).send({ error: 'Secret storage not configured' });
      }
      const parsed = SecretPutInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid secret',
          details: parsed.error.issues,
        });
      }
      const { key, value } = parsed.data;
      try {
        await secretProvider.set(request.params.id, key, value);
        return reply.status(201).send(SecretPutResponseSchema.parse({ key }));
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
