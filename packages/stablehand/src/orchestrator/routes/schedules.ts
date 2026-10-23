import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CUSTOM_EVENT_PAYLOAD_MAX_BYTES,
  customEventPayloadTooLargeError,
  ScheduleCreateInputSchema,
  ScheduleListResponseSchema,
  SchedulePatchInputSchema,
  ScheduleSchema,
  serializedJsonByteLength,
} from '@stablehand/contracts';

import {
  ScheduleAgentNotFoundError,
  ScheduleConflictError,
  ScheduleValidationError,
  validateRecurringCron,
  type ScheduleService,
} from '../../schedules/index.js';

export interface ScheduleRouteOptions {
  service: Pick<ScheduleService, 'list' | 'get' | 'create' | 'update' | 'delete' | 'fireNow'>;
}

function invalidBody(reply: FastifyReply, issues: { path: PropertyKey[]; message: string }[]) {
  return reply.status(400).send({
    error: 'invalid_schedule',
    issues: issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

/** Serialized size of an oversized object payload, or undefined when it fits. */
function oversizedPayloadBytes(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const bytes = serializedJsonByteLength(value);
  return bytes > CUSTOM_EVENT_PAYLOAD_MAX_BYTES ? bytes : undefined;
}

function mapServiceError(error: unknown, reply: FastifyReply) {
  if (error instanceof ScheduleValidationError) {
    return reply.status(400).send({ error: 'invalid_schedule', message: error.message });
  }
  if (error instanceof ScheduleAgentNotFoundError) {
    return reply.status(404).send({ error: 'Agent not found' });
  }
  if (error instanceof ScheduleConflictError) {
    return reply.status(409).send({ error: error.message });
  }
  throw error;
}

export async function scheduleRoutes(
  app: FastifyInstance,
  { service }: ScheduleRouteOptions,
): Promise<void> {
  app.get('/', { config: { capability: 'schedules:manage' } }, async () => ScheduleListResponseSchema.parse({
    schedules: await service.list(),
  }));

  app.post('/', { config: { capability: 'schedules:manage' } }, async (
    request: FastifyRequest<{ Body: unknown }>,
    reply,
  ) => {
    const raw = request.body as { payload?: unknown } | undefined;
    const oversizedBytes = oversizedPayloadBytes(raw?.payload);
    if (oversizedBytes !== undefined) {
      return reply.status(413).send(customEventPayloadTooLargeError(oversizedBytes));
    }
    const parsed = ScheduleCreateInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error.issues);
    try {
      validateRecurringCron(parsed.data.cronExpression, parsed.data.timezone);
      return reply.status(201).send(ScheduleSchema.parse(await service.create(parsed.data)));
    } catch (error) {
      return mapServiceError(error, reply);
    }
  });

  app.get('/:id', { config: { capability: 'schedules:manage' } }, async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply,
  ) => {
    const schedule = await service.get(request.params.id);
    if (!schedule) return reply.status(404).send({ error: 'Schedule not found' });
    return ScheduleSchema.parse(schedule);
  });

  app.patch('/:id', { config: { capability: 'schedules:manage' } }, async (
    request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
    reply,
  ) => {
    const raw = request.body as { payload?: unknown } | undefined;
    const oversizedBytes = oversizedPayloadBytes(raw?.payload);
    if (oversizedBytes !== undefined) {
      return reply.status(413).send(customEventPayloadTooLargeError(oversizedBytes));
    }
    const parsed = SchedulePatchInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error.issues);
    try {
      const schedule = await service.update(request.params.id, parsed.data);
      if (!schedule) return reply.status(404).send({ error: 'Schedule not found' });
      return ScheduleSchema.parse(schedule);
    } catch (error) {
      return mapServiceError(error, reply);
    }
  });

  // POST /api/schedules/:id/fire: emit the schedule's event once, now.
  app.post('/:id/fire', { config: { capability: 'schedules:manage' } }, async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply,
  ) => {
    const schedule = await service.fireNow(request.params.id);
    if (!schedule) return reply.status(404).send({ error: 'Schedule not found' });
    return ScheduleSchema.parse(schedule);
  });

  app.delete('/:id', { config: { capability: 'schedules:manage' } }, async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply,
  ) => {
    if (!await service.delete(request.params.id)) {
      return reply.status(404).send({ error: 'Schedule not found' });
    }
    return reply.status(204).send();
  });
}
