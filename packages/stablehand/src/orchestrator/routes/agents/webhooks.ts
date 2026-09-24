import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  WebhookSchema,
  WebhookCreateInputSchema,
  WebhookPatchInputSchema,
  type Webhook,
  type WebhookCreateInput,
  type WebhookPatchInput,
} from '@stablehand/contracts';

import type { WebhookRow } from '../../../database/repository.js';
import type { AgentSubRouteOptions } from './types.js';

type WebhookValidationResult<T> =
  | { ok: true; body: T }
  | {
      ok: false;
      error: {
        error: 'Invalid webhook definition';
        issues: Array<{ path: string; message: string }>;
      };
    };

function webhookValidationError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) {
  return {
    error: 'Invalid webhook definition' as const,
    issues: issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

function validateWebhookCreateBody(body: unknown): WebhookValidationResult<WebhookCreateInput> {
  const result = WebhookCreateInputSchema.safeParse(body);
  if (result.success) {
    return { ok: true, body: result.data };
  }
  return {
    ok: false,
    error: webhookValidationError(result.error.issues),
  };
}

function validateWebhookPatchBody(body: unknown): WebhookValidationResult<WebhookPatchInput> {
  const result = WebhookPatchInputSchema.safeParse(body);
  if (result.success) {
    return { ok: true, body: result.data };
  }
  return {
    ok: false,
    error: webhookValidationError(result.error.issues),
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

  app.post('/:id/webhooks', {
    preHandler: [loadAgent],
    config: { capability: 'webhooks:manage' },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const validated = validateWebhookCreateBody(request.body);
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

  app.patch('/:id/webhooks/:webhookId', {
    preHandler: [loadAgent],
    config: { capability: 'webhooks:manage' },
  }, async (request, reply) => {
    const { id, webhookId } = request.params as { id: string; webhookId: string };
    const validated = validateWebhookPatchBody(request.body);
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

  app.get('/:id/webhooks', {
    preHandler: [loadAgent],
    config: { capability: 'webhooks:manage' },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const hooks = await db.listWebhooks(id);
    return reply.send(hooks.map(toApiWebhook));
  });

  app.delete('/:id/webhooks/:webhookId', {
    preHandler: [loadAgent],
    config: { capability: 'webhooks:manage' },
  }, async (request, reply) => {
    const { id, webhookId } = request.params as { id: string; webhookId: string };
    const deleted = await db.deleteWebhookForAgent(webhookId, id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return reply.status(204).send();
  });
}
