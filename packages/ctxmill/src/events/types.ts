// AG-UI event types — re-exported from shared package
export type { AGUIEventType, AGUIEvent } from '@ctxmill/shared';

// Internal event types are now defined by the EventMap in bus.ts.
// Re-export for backward compatibility.
export type { EventMap, EventName } from './bus.js';
