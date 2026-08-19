import { describe, expect, it } from 'vitest';

import {
  ScheduleCreateInputSchema,
  ScheduleListResponseSchema,
  SchedulePatchInputSchema,
  ScheduleSchema,
} from './schedules.js';

const schedule = {
  id: 'schedule-1',
  agentId: 'agent-1',
  name: 'weekly-canary',
  cronExpression: '0 9 * * 1',
  timezone: 'America/New_York',
  eventType: 'custom.schedule.weekly-canary',
  payload: { source: 'canary' },
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  lastFiredAt: null,
  missedFireCount: 0,
  nextRunAt: 3,
};

describe('schedule contracts', () => {
  it('owns strict create, patch, item, and list boundaries', () => {
    expect(ScheduleCreateInputSchema.parse({
      agentId: schedule.agentId,
      name: schedule.name,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      eventType: schedule.eventType,
      payload: schedule.payload,
    })).toEqual({
      agentId: schedule.agentId,
      name: schedule.name,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      eventType: schedule.eventType,
      payload: schedule.payload,
      enabled: true,
    });
    expect(SchedulePatchInputSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(ScheduleSchema.parse(schedule)).toEqual(schedule);
    expect(ScheduleListResponseSchema.parse({ schedules: [schedule] }).schedules).toHaveLength(1);

    expect(ScheduleCreateInputSchema.parse({
      name: 'global-clock',
      cronExpression: '0 * * * *',
      eventType: 'custom.schedule.global-clock',
    })).toEqual({
      name: 'global-clock',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      eventType: 'custom.schedule.global-clock',
      payload: {},
      enabled: true,
    });
    expect(ScheduleSchema.parse({ ...schedule, agentId: null })).toMatchObject({
      agentId: null,
    });
  });

  it('inherits the canonical custom-event grammar and payload cap', () => {
    expect(() => ScheduleCreateInputSchema.parse({
      agentId: 'agent-1',
      name: 'invalid-event',
      cronExpression: '* * * * *',
      eventType: 'schedule.invalid',
      payload: {},
    })).toThrow();
    expect(() => ScheduleCreateInputSchema.parse({
      agentId: 'agent-1',
      name: 'oversized',
      cronExpression: '* * * * *',
      eventType: 'custom.schedule.oversized',
      payload: { content: 'x'.repeat(33 * 1024) },
    })).toThrow();
  });

  it('rejects empty patches, agent reassignment, and unknown fields', () => {
    expect(() => SchedulePatchInputSchema.parse({})).toThrow();
    expect(() => SchedulePatchInputSchema.parse({ agentId: 'agent-2' })).toThrow();
    expect(() => ScheduleCreateInputSchema.parse({
      agentId: 'agent-1',
      name: 'unknown-field',
      cronExpression: '* * * * *',
      eventType: 'custom.schedule.unknown-field',
      payload: {},
      unexpected: true,
    })).toThrow();
  });
});
