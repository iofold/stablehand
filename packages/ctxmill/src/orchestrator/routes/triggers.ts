import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  CUSTOM_EVENT_PAYLOAD_MAX_BYTES,
  CustomEventEmitInputSchema,
  serializedJsonByteLength,
  type CustomEventPayloadTooLargeError,
} from '@ctxmill/contracts';
import { TriggerConflictError, type EventTriggerManager } from '../../events/trigger-manager.js';
import type { DatabaseRepository } from '../../database/repository.js';

export interface TriggerRouteOptions {
  triggerManager: EventTriggerManager;
  db: DatabaseRepository;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * REST API routes for event triggers and custom event emission.
 */
export async function triggerRoutes(
  app: FastifyInstance,
  opts: TriggerRouteOptions,
): Promise<void> {
  const { triggerManager, db } = opts;

  // POST /api/triggers — Create a new trigger
  app.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          agentId: string;
          eventType: string;
          selector?: unknown;
          taskTemplate: string;
          enabled?: boolean;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as {
        agentId?: string;
        eventType?: string;
        selector?: unknown;
        taskTemplate?: string;
        enabled?: boolean;
      } | undefined;

      if (!body?.agentId || !body.eventType || !body.taskTemplate) {
        return reply.status(400).send({
          error: 'agentId, eventType, and taskTemplate are required',
        });
      }

      if (body.selector !== undefined && !isJsonObject(body.selector)) {
        return reply.status(400).send({ error: 'selector must be a JSON object' });
      }

      // Verify agent exists
      const agent = await db.getAgent(body.agentId);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found', agentId: body.agentId });
      }

      let trigger;
      try {
        trigger = await triggerManager.register({
          agentId: body.agentId,
          eventType: body.eventType,
          selector: body.selector,
          taskTemplate: body.taskTemplate,
          enabled: body.enabled ?? true,
        });
      } catch (err) {
        if (err instanceof TriggerConflictError) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }

      return reply.status(201).send(trigger);
    },
  );

  // GET /api/triggers — List all triggers (optional ?agentId filter)
  app.get(
    '/',
    async (request: FastifyRequest) => {
      const query = request.query as { agentId?: string };
      return triggerManager.list(query.agentId);
    },
  );

  // GET /api/triggers/:id — Get a single trigger
  app.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const trigger = triggerManager.get(id);
      if (!trigger) {
        return reply.status(404).send({ error: 'Trigger not found' });
      }
      return trigger;
    },
  );

  // PUT /api/triggers/:id — Update a trigger
  app.put(
    '/:id',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          enabled?: boolean;
          taskTemplate?: string;
          selector?: unknown;
          eventType?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        enabled?: boolean;
        taskTemplate?: string;
        selector?: unknown;
        eventType?: string;
      } | undefined;

      if (!body) {
        return reply.status(400).send({ error: 'Request body is required' });
      }

      if (
        body.selector !== undefined
        && body.selector !== null
        && !isJsonObject(body.selector)
      ) {
        return reply.status(400).send({ error: 'selector must be a JSON object or null' });
      }

      const updates = {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.taskTemplate !== undefined ? { taskTemplate: body.taskTemplate } : {}),
        ...(body.eventType !== undefined ? { eventType: body.eventType } : {}),
        ...(body.selector !== undefined ? {
          selector: body.selector === null ? undefined : body.selector,
        } : {}),
      };

      let updated;
      try {
        updated = await triggerManager.update(id, updates);
      } catch (err) {
        if (err instanceof TriggerConflictError) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
      if (!updated) {
        return reply.status(404).send({ error: 'Trigger not found' });
      }

      return updated;
    },
  );

  // DELETE /api/triggers/:id — Delete a trigger
  app.delete(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const removed = await triggerManager.unregister(id);
      if (!removed) {
        return reply.status(404).send({ error: 'Trigger not found' });
      }
      return { ok: true };
    },
  );

  // POST /api/triggers/emit — Emit a custom event (for external integrations)
  app.post(
    '/emit',
    async (
      request: FastifyRequest<{
        Body: {
          type: string;
          agentId?: string;
          payload: Record<string, unknown>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as {
        type?: string;
        agentId?: string;
        payload?: unknown;
      } | undefined;

      if (
        body
        && isJsonObject(body.payload)
        && serializedJsonByteLength(body.payload) > CUSTOM_EVENT_PAYLOAD_MAX_BYTES
      ) {
        const error: CustomEventPayloadTooLargeError = {
          error: 'custom_event_payload_too_large',
          maxBytes: CUSTOM_EVENT_PAYLOAD_MAX_BYTES,
        };
        return reply.status(413).send(error);
      }

      const validated = CustomEventEmitInputSchema.safeParse(body);
      if (!validated.success) {
        return reply.status(400).send({
          error: 'invalid_custom_event',
          issues: validated.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      // ctx-mcef: _triggerDepth is internal cascade bookkeeping. An external
      // caller must never set it — stripping here means every HTTP emit
      // starts a fresh cascade at depth zero, and the maxTriggerDepth guard
      // is enforced rather than advisory.
      const { _triggerDepth: _clientDepth, ...payload } = validated.data.payload;
      await triggerManager.emitCustomEventAsync(
        validated.data.type,
        validated.data.agentId,
        payload,
      );

      return { ok: true, type: validated.data.type };
    },
  );
}
