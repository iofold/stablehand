import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { VALID_WEBHOOK_EVENTS, isValidWebhookEvent } from '../../webhook-events.js';
import type { AgentSubRouteOptions } from './types.js';

type WebhookBody = {
  url?: string;
  events?: string[];
  secret?: string | null;
};

type ValidatedWebhookBody = {
  url: string;
  events: string[];
  secret?: string | null;
};

type WebhookValidationResult =
  | { ok: true; body: ValidatedWebhookBody }
  | { ok: false; error: { error: string; validEvents?: typeof VALID_WEBHOOK_EVENTS } };

function validateWebhookBody(body: WebhookBody | undefined): WebhookValidationResult {
  if (!body?.url || !body?.events?.length) {
    return { ok: false, error: { error: 'url and events are required' } };
  }

  const invalidEvents = body.events.filter((eventType) => !isValidWebhookEvent(eventType));
  if (invalidEvents.length > 0) {
    return {
      ok: false,
      error: {
        error: `Invalid event types: ${invalidEvents.join(', ')}`,
        validEvents: VALID_WEBHOOK_EVENTS,
      },
    };
  }

  return {
    ok: true,
    body: {
      url: body.url,
      events: body.events,
      secret: body.secret,
    },
  };
}

export async function webhookRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, loadAgent } = opts;

  app.post('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const validated = validateWebhookBody(request.body as WebhookBody | undefined);
    if (!validated.ok) {
      return reply.status(400).send(validated.error);
    }
    const body = validated.body;

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

  app.put('/:id/webhooks/:webhookId', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id, webhookId } = request.params as { id: string; webhookId: string };
    const validated = validateWebhookBody(request.body as WebhookBody | undefined);
    if (!validated.ok) {
      return reply.status(400).send(validated.error);
    }
    const body = validated.body;

    const updated = await db.updateWebhookForAgent(webhookId, id, {
      url: body.url,
      events: body.events,
      secret: body.secret ?? null,
    });
    if (!updated) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }

    return reply.send(updated);
  });

  app.get('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const hooks = await db.listWebhooks(id);
    return reply.send(hooks);
  });

  app.delete('/:id/webhooks/:webhookId', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id, webhookId } = request.params as { id: string; webhookId: string };
    const deleted = await db.deleteWebhookForAgent(webhookId, id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return reply.status(204).send();
  });
}
