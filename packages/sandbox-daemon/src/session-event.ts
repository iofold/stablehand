import type { AGUIEvent, MessageCommittedEvent } from '@ctxmill/shared';

export interface AGUISessionEvent {
  type: 'ag_ui_event';
  event: AGUIEvent;
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

export type SessionEvent = AGUISessionEvent | MessageCommittedSessionEvent;
