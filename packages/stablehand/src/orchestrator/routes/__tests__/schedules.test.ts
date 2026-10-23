import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScheduleListResponseSchema, ScheduleSchema } from '@stablehand/contracts';
import { scheduleRoutes } from '../schedules.js';
import {
  ScheduleAgentNotFoundError,
  ScheduleConflictError,
} from '../../../schedules/service.js';

const stored = {
  id: 'schedule-1',
  agentId: 'agent-1',
  name: 'weekly-canary',
  cronExpression: '0 9 * * 1',
  timezone: 'UTC',
  eventType: 'custom.schedule.weekly-canary',
  payload: { source: 'canary' },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  lastFiredAt: null,
  missedFireCount: 0,
  nextRunAt: 2,
};

async function createApp(overrides: Record<string, unknown> = {}) {
  const service = {
    list: vi.fn().mockResolvedValue([stored]),
    get: vi.fn().mockResolvedValue(stored),
    create: vi.fn().mockResolvedValue(stored),
    update: vi.fn().mockResolvedValue(stored),
    delete: vi.fn().mockResolvedValue(true),
    fireNow: vi.fn().mockResolvedValue({ ...stored, lastFiredAt: 5 }),
    ...overrides,
  };
  const app = Fastify({ logger: false });
  await app.register(scheduleRoutes, { prefix: '/api/schedules', service: service as never });
  return { app, service };
}

describe('schedule routes', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>['app']> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns canonical list and item responses with nextRunAt', async () => {
    const { app } = await createApp();
    apps.push(app);

    const list = await app.inject({ method: 'GET', url: '/api/schedules' });
    const one = await app.inject({ method: 'GET', url: '/api/schedules/schedule-1' });

    expect(ScheduleListResponseSchema.parse(list.json()).schedules).toHaveLength(1);
    expect(ScheduleSchema.parse(one.json()).nextRunAt).toBe(2);
  });

  it('validates Croner grammar and IANA timezones before persistence', async () => {
    const { app, service } = await createApp();
    apps.push(app);

    for (const input of [
      { cronExpression: 'not cron', timezone: 'UTC' },
      { cronExpression: '2026-08-01T00:00:00Z', timezone: 'UTC' },
      { cronExpression: '* * * * *', timezone: 'Mars/Olympus_Mons' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: {
          agentId: 'agent-1',
          name: 'weekly-canary',
          eventType: 'custom.schedule.weekly-canary',
          payload: {},
          ...input,
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(service.create).not.toHaveBeenCalled();
  });

  it('persists valid creates and reconciles PATCH and DELETE through the service', async () => {
    const { app, service } = await createApp();
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: {
        agentId: 'agent-1',
        name: 'weekly-canary',
        cronExpression: '0 9 * * 1',
        timezone: 'America/New_York',
        eventType: 'custom.schedule.weekly-canary',
        payload: { source: 'canary' },
      },
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/schedules/schedule-1',
      payload: { enabled: false },
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/schedules/schedule-1',
    });

    expect(created.statusCode).toBe(201);
    expect(patched.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(204);
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'America/New_York' }));
    expect(service.update).toHaveBeenCalledWith('schedule-1', { enabled: false });
    expect(service.delete).toHaveBeenCalledWith('schedule-1');
  });

  it('returns 404 for missing schedules and rejects empty patches', async () => {
    const { app } = await createApp({
      get: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(false),
    });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/api/schedules/missing' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/api/schedules/missing', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/schedules/missing' })).statusCode).toBe(404);
  });

  it('maps payload caps and service conflicts to stable HTTP statuses', async () => {
    const tooLarge = await createApp();
    const duplicate = await createApp({
      create: vi.fn().mockRejectedValue(new ScheduleConflictError('duplicate schedule')),
    });
    const missingAgent = await createApp({
      create: vi.fn().mockRejectedValue(new ScheduleAgentNotFoundError('missing agent')),
    });
    apps.push(tooLarge.app, duplicate.app, missingAgent.app);
    const payload = {
      agentId: 'agent-1',
      name: 'weekly-canary',
      cronExpression: '0 9 * * 1',
      eventType: 'custom.schedule.weekly-canary',
      payload: { content: 'x'.repeat(257 * 1024) },
    };

    const oversized = await tooLarge.app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload,
    });
    const conflict = await duplicate.app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { ...payload, payload: {} },
    });
    const notFound = await missingAgent.app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { ...payload, payload: {} },
    });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: expect.stringContaining('the limit is 262144 bytes (256 KiB)'),
      code: 'custom_event_payload_too_large',
      maxBytes: 256 * 1024,
      sizeBytes: expect.any(Number),
    });
    expect(tooLarge.service.create).not.toHaveBeenCalled();
    expect(conflict.statusCode).toBe(409);
    expect(notFound.statusCode).toBe(404);
  });

  it('fires a schedule now and returns it with the new last fire', async () => {
    const { app, service } = await createApp();
    apps.push(app);

    const fired = await app.inject({ method: 'POST', url: '/api/schedules/schedule-1/fire' });

    expect(fired.statusCode).toBe(200);
    expect(ScheduleSchema.parse(fired.json()).lastFiredAt).toBe(5);
    expect(service.fireNow).toHaveBeenCalledWith('schedule-1');
  });

  it('returns 404 when firing a schedule that does not exist', async () => {
    const { app } = await createApp({ fireNow: vi.fn().mockResolvedValue(undefined) });
    apps.push(app);

    const fired = await app.inject({ method: 'POST', url: '/api/schedules/missing/fire' });

    expect(fired.statusCode).toBe(404);
    expect(fired.json()).toEqual({ error: 'Schedule not found' });
  });
});
