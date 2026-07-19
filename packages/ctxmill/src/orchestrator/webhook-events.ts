import type { EventName } from '../events/bus.js';

export const VALID_WEBHOOK_EVENTS = [
  'turn.started',
  'turn.completed',
  'tool_call.started',
  'tool_call.completed',
  'interrupt.requested',
  'interrupt.resolved',
  'message.committed',
  'message.updated',
  'feedback.received',
  'budget.threshold',
] as const satisfies readonly EventName[];

export type ValidWebhookEvent = typeof VALID_WEBHOOK_EVENTS[number];

export function isValidWebhookEvent(eventType: string): eventType is ValidWebhookEvent {
  return (VALID_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}
