// AG-UI event types — re-exported from shared package
export type { AGUIEventType, AGUIEvent } from '@ctxmill/shared';

// A2UI payload attached to messages
export interface A2UIPayload {
  component?: string;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

// Internal event bus events
export type InternalEventType =
  | 'agent.created'
  | 'agent.status_changed'
  | 'agent.message_received'
  | 'tool.call_started'
  | 'tool.call_completed'
  | 'tool.call_failed'
  | 'trace.captured'
  | 'feedback.received'
  | 'insight.extracted'
  | 'knowledge.updated';

export interface InternalEvent {
  type: InternalEventType;
  timestamp: Date;
  payload: Record<string, unknown>;
}
