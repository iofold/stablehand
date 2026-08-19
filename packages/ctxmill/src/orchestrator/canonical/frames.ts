import type { EventName } from '../../events/bus.js';

/**
 * Canonical AG-UI frame vocabulary (ADR-015): the 12 spec event types plus
 * CUSTOM. Orchestrator-specific signals ride as CUSTOM{name: 'ctxmill.*'}.
 */
export const CANONICAL_FRAME_TYPES = [
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'STATE_DELTA',
  'MESSAGES_SNAPSHOT',
  'CUSTOM',
] as const;

export type CanonicalFrameType = typeof CANONICAL_FRAME_TYPES[number];

export const CTXMILL_CUSTOM_NAMES = [
  'ctxmill.turn.pending',
  'ctxmill.interrupt.requested',
  'ctxmill.interrupt.resolved',
  'ctxmill.sandbox_session.snapshot',
  'ctxmill.message.committed',
  'ctxmill.message.updated',
  'ctxmill.a2ui.render',
] as const;

export type FrameChannel = 'run' | 'custom' | 'system';

/**
 * A canonical frame as produced by the projector. `body` is the wire-shaped
 * payload (persisted as JSON); provenance fields become event_store columns.
 */
export interface CanonicalFrame {
  type: string;
  channel: FrameChannel;
  agentId: string;
  turnId?: string | null;
  conversationId?: string | null;
  body: Record<string, unknown>;
  /** Raw TypedEventBus event name. Set only on the first frame from one bus event. */
  sourceType?: string | null;
  /** JSON-serialized raw TypedEventBus payload. Set only with sourceType. */
  sourcePayload?: string | null;
}

/** A frame after persistence, carrying its global seq. */
export interface PersistedFrame extends CanonicalFrame {
  seq: number;
  createdAt: number;
}

/** Internal bus events projected onto the run channel. */
export const RUN_CHANNEL_EVENTS: readonly EventName[] = [
  'turn.pending',
  'turn.started',
  'message.delta',
  'tool_call.started',
  'tool_call.completed',
  'interrupt.requested',
  'interrupt.resolved',
  'ag_ui.event',
  'turn.completed',
  'user.message',
  'message.committed',
  'message.updated',
];

/** Every EventMap name — used to split system events from user-defined custom types. */
export const KNOWN_BUS_EVENT_NAMES: readonly string[] = [
  'turn.started',
  'message.delta',
  'tool_call.started',
  'tool_call.completed',
  'interrupt.requested',
  'interrupt.resolved',
  'turn.completed',
  'budget.threshold',
  'feedback.received',
  'artifact.created',
  'artifact.deleted',
  'turn.cancelled',
  'agent.created',
  'agent.deleted',
  'client.connected',
  'client.disconnected',
  'trigger.fired',
  'message.committed',
  'message.updated',
  'turn.pending',
  'ag_ui.event',
  'user.message',
  'custom',
];

export function classifyChannel(eventName: string): FrameChannel {
  if ((RUN_CHANNEL_EVENTS as readonly string[]).includes(eventName)) {
    return 'run';
  }
  return KNOWN_BUS_EVENT_NAMES.includes(eventName) ? 'system' : 'custom';
}
