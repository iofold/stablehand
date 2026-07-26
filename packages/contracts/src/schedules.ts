import { z } from 'zod';

import {
  CustomEventNameSchema,
  CustomEventPayloadSchema,
} from './api.js';
import { AgentIdSchema } from './ids.js';

export const ScheduleIdSchema = z.string().trim().min(1);
export const ScheduleNameSchema = z.string().trim().min(1).max(128);
export const CronExpressionSchema = z.string().trim().min(1).max(512);
export const ScheduleTimezoneSchema = z.string().trim().min(1).max(128);

export const ScheduleCreateInputSchema = z.strictObject({
  agentId: AgentIdSchema.optional(),
  name: ScheduleNameSchema,
  cronExpression: CronExpressionSchema,
  timezone: ScheduleTimezoneSchema.default('UTC'),
  eventType: CustomEventNameSchema,
  payload: CustomEventPayloadSchema.default({}),
  enabled: z.boolean().default(true),
});

export const SchedulePatchInputSchema = z.strictObject({
  name: ScheduleNameSchema.optional(),
  cronExpression: CronExpressionSchema.optional(),
  timezone: ScheduleTimezoneSchema.optional(),
  eventType: CustomEventNameSchema.optional(),
  payload: CustomEventPayloadSchema.optional(),
  enabled: z.boolean().optional(),
}).refine(
  (input) => Object.keys(input).length > 0,
  'At least one schedule field is required',
);

export const ScheduleSchema = z.strictObject({
  id: ScheduleIdSchema,
  agentId: AgentIdSchema.nullable(),
  name: ScheduleNameSchema,
  cronExpression: CronExpressionSchema,
  timezone: ScheduleTimezoneSchema,
  eventType: CustomEventNameSchema,
  payload: CustomEventPayloadSchema,
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastFiredAt: z.number().int().nonnegative().nullable(),
  nextRun: z.number().int().nonnegative().nullable(),
});

export const ScheduleListResponseSchema = z.strictObject({
  schedules: z.array(ScheduleSchema),
});

export type ScheduleId = z.infer<typeof ScheduleIdSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ScheduleCreateInput = z.input<typeof ScheduleCreateInputSchema>;
export type SchedulePatchInput = z.input<typeof SchedulePatchInputSchema>;
