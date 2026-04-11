import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import type { AgentSubRouteOptions } from './types.js';

const VALID_WEBHOOK_EVENTS = [
  'turn.started',
  'turn.completed',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
];

export async function webhookRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, loadAgent } = opts;

  app.post('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { url?: string; events?: string[]; secret?: string } | undefined;

    if (!body?.url || !body?.events?.length) {
      return reply.status(400).send({ error: 'url and events are required' });
    }

    const invalidEvents = body.events.filter((eventType) => !VALID_WEBHOOK_EVENTS.includes(eventType));
    if (invalidEvents.length > 0) {
      return reply.status(400).send({
        error: `Invalid event types: ${invalidEvents.join(', ')}`,
        validEvents: VALID_WEBHOOK_EVENTS,
      });
    }

    const now = Date.now();
    const webhook = await db.createWebhook({
      id: randomUUID(),
      agentId: id,
      url: body.url,
      events: body.events,
      secret: body.secret ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return reply.status(201).send(webhook);
  });

  app.get('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const hooks = await db.listWebhooks(id);
    return reply.send(hooks);
  });

  app.delete('/:id/webhooks/:webhookId', { preHandler: [loadAgent] }, async (request, reply) => {
    const { webhookId } = request.params as { id: string; webhookId: string };
    const deleted = await db.deleteWebhook(webhookId);
    if (!deleted) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return reply.status(204).send();
  });
}
