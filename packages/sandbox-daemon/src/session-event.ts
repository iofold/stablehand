import type { AgentSessionEvent, MessageCommittedEvent } from '@stablehand/shared';

export interface AGUISessionEvent {
  type: 'ag_ui_event';
  event: AgentSessionEvent;
}

export interface MessageCommittedSessionEvent {
  type: 'message_committed';
  role: 'assistant' | 'tool';
  content: string;
  toolCalls?: MessageCommittedEvent['toolCalls'];
  toolCallId?: string;
  turnId: string;
  messageSeq: number;
}

export interface TurnFailedSessionEvent {
  type: 'turn_failed';
  turnId: string;
  errorMessage: string;
}

export type SessionEvent = AGUISessionEvent | MessageCommittedSessionEvent | TurnFailedSessionEvent;
