import type { AgentSessionEvent, MessageCommittedEvent } from '@stablehand/shared';

/** Daemon journal position of an event (ADR 024): journal id + 1-based seq. */
export interface DeliveryStamp {
  id: string;
  seq: number;
}

interface DeliveryStamped {
  delivery?: DeliveryStamp;
}

export interface AGUISessionEvent extends DeliveryStamped {
  type: 'ag_ui_event';
  event: AgentSessionEvent;
}

export interface MessageCommittedSessionEvent extends DeliveryStamped {
  type: 'message_committed';
  role: 'assistant' | 'tool';
  content: string;
  toolCalls?: MessageCommittedEvent['toolCalls'];
  toolCallId?: string;
  turnId: string;
  messageSeq: number;
}

export interface TurnFailedSessionEvent extends DeliveryStamped {
  type: 'turn_failed';
  turnId: string;
  errorMessage: string;
}

export type SessionEvent = AGUISessionEvent | MessageCommittedSessionEvent | TurnFailedSessionEvent;
