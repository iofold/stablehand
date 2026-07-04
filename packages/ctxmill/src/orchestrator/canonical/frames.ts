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
  'ctxmill.hitl.requested',
  'ctxmill.hitl.resolved',
  'ctxmill.message.committed',
  'ctxmill.a2ui.render',
] as const;

export type CtxmillCustomName = typeof CTXMILL_CUSTOM_NAMES[number];

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
}

/** A frame after persistence, carrying its global seq. */
export interface PersistedFrame extends CanonicalFrame {
  seq: number;
  createdAt: number;
}

export function isCanonicalFrameType(type: string): type is CanonicalFrameType {
  return (CANONICAL_FRAME_TYPES as readonly string[]).includes(type);
}

/** Internal bus events projected onto the run channel. */
export const RUN_CHANNEL_EVENTS: readonly EventName[] = [
  'turn.pending',
  'turn.started',
  'run.text_chunk',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'run.ag_ui_event',
  'turn.completed',
  'user.message',
  'message.committed',
];

/** Every EventMap name — used to split system events from user-defined custom types. */
export const KNOWN_BUS_EVENT_NAMES: readonly string[] = [
  'turn.started',
  'run.text_chunk',
  'run.tool_started',
  'run.tool_result',
  'run.interrupted',
  'run.interrupt_resolved',
  'turn.completed',
  'feedback.received',
  'agent.created',
  'agent.deleted',
  'client.connected',
  'client.disconnected',
  'run.resumed',
  'trigger.fired',
  'message.committed',
  'turn.pending',
  'run.ag_ui_event',
  'user.message',
  'custom',
];

export function classifyChannel(eventName: string): FrameChannel {
  if ((RUN_CHANNEL_EVENTS as readonly string[]).includes(eventName)) {
    return 'run';
  }
  return KNOWN_BUS_EVENT_NAMES.includes(eventName) ? 'system' : 'custom';
}
