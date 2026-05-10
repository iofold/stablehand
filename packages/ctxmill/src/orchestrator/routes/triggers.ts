import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TriggerConflictError, type EventTriggerManager } from '../../events/trigger-manager.js';
import type { DatabaseRepository } from '../../database/repository.js';

export interface TriggerRouteOptions {
  triggerManager: EventTriggerManager;
  db: DatabaseRepository;
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
          selector?: Record<string, unknown>;
          taskTemplate: string;
          enabled?: boolean;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body as {
        agentId?: string;
        eventType?: string;
        selector?: Record<string, unknown>;
        taskTemplate?: string;
        enabled?: boolean;
      } | undefined;

      if (!body?.agentId || !body.eventType || !body.taskTemplate) {
        return reply.status(400).send({
          error: 'agentId, eventType, and taskTemplate are required',
        });
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
          selector?: Record<string, unknown>;
          eventType?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const body = request.body as {
        enabled?: boolean;
        taskTemplate?: string;
        selector?: Record<string, unknown>;
        eventType?: string;
      } | undefined;

      if (!body) {
        return reply.status(400).send({ error: 'Request body is required' });
      }

      let updated;
      try {
        updated = await triggerManager.update(id, body);
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
        payload?: Record<string, unknown>;
      } | undefined;

      if (!body?.type || !body.payload || typeof body.payload !== 'object') {
        return reply.status(400).send({
          error: 'type and payload are required; payload must be an object',
        });
      }

      await triggerManager.emitCustomEventAsync(body.type, body.agentId, body.payload);

      return { ok: true, type: body.type };
    },
  );
}
