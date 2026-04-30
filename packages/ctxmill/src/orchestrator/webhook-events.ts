import type { EventName } from '../events/bus.js';

export const VALID_WEBHOOK_EVENTS = [
  'turn.started',
  'turn.completed',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'message.committed',
  'feedback.received',
] as const satisfies readonly EventName[];

export type ValidWebhookEvent = typeof VALID_WEBHOOK_EVENTS[number];

export function isValidWebhookEvent(eventType: string): eventType is ValidWebhookEvent {
  return (VALID_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}
