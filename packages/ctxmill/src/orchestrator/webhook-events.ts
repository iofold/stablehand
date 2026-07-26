import type { EventName } from '../events/bus.js';
import {
  BUILTIN_WEBHOOK_EVENT_NAMES,
  isCustomEventName,
  type BuiltinWebhookEventName,
} from '@ctxmill/contracts';

export const VALID_WEBHOOK_EVENTS = BUILTIN_WEBHOOK_EVENT_NAMES satisfies readonly EventName[];

export type ValidWebhookEvent = BuiltinWebhookEventName | `custom.${string}`;

export function isValidWebhookEvent(eventType: string): eventType is ValidWebhookEvent {
  return isBuiltinWebhookEvent(eventType) || isCustomEventName(eventType);
}

export function isBuiltinWebhookEvent(eventType: string): eventType is BuiltinWebhookEventName {
  return (VALID_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}
