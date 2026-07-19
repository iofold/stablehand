import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  WebhookSchema,
  WebhookUpsertInputSchema,
  type Webhook,
  type WebhookUpsertInput,
} from '@ctxmill/contracts';

import type { WebhookRow } from '../../../database/repository.js';
import type { AgentSubRouteOptions } from './types.js';

type WebhookValidationResult =
  | { ok: true; body: WebhookUpsertInput }
  | {
      ok: false;
      error: {
        error: 'Invalid webhook definition';
        issues: Array<{ path: string; message: string }>;
      };
    };

function validateWebhookBody(body: unknown): WebhookValidationResult {
  const result = WebhookUpsertInputSchema.safeParse(body);
  if (result.success) {
    return { ok: true, body: result.data };
  }
  return {
    ok: false,
    error: {
      error: 'Invalid webhook definition',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  };
}

function toApiWebhook(webhook: WebhookRow): Webhook {
  const { secret, ...safeWebhook } = webhook;
  return WebhookSchema.parse({
    ...safeWebhook,
    hasSecret: typeof secret === 'string' && secret.length > 0,
  });
}

export async function webhookRoutes(
  app: FastifyInstance,
  opts: AgentSubRouteOptions,
): Promise<void> {
  const { db, loadAgent } = opts;

  app.post('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const validated = validateWebhookBody(request.body);
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
      secret: body.secret,
      createdAt: now,
      updatedAt: now,
    });

    return reply.status(201).send(toApiWebhook(webhook));
  });

  app.put('/:id/webhooks/:webhookId', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id, webhookId } = request.params as { id: string; webhookId: string };
    const validated = validateWebhookBody(request.body);
    if (!validated.ok) {
      return reply.status(400).send(validated.error);
    }
    const body = validated.body;

    const updated = await db.updateWebhookForAgent(webhookId, id, {
      url: body.url,
      events: body.events,
      secret: body.secret,
    });
    if (!updated) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }

    return reply.send(toApiWebhook(updated));
  });

  app.get('/:id/webhooks', { preHandler: [loadAgent] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const hooks = await db.listWebhooks(id);
    return reply.send(hooks.map(toApiWebhook));
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
