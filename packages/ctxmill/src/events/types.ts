// AG-UI event types — re-exported from shared package
export type { AGUIEventType, AGUIEvent } from '@ctxmill/shared';

// A2UI payload attached to messages
export interface A2UIPayload {
  component?: string;
  props?: Record<string, unknown>;
  [key: string]: unknown;
}

// Internal event types are now defined by the EventMap in bus.ts.
// Re-export for backward compatibility.
export type { EventMap, EventName } from './bus.js';
