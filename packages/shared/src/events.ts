import type { ApiToolCallState, ApiMessagePart } from './api.js';

export type AgentSessionEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'STATE_DELTA'
  | 'MESSAGES_SNAPSHOT'
  | 'INTERRUPT_REQUESTED'
  | 'MESSAGE_COMMITTED'
  | 'CUSTOM';

export interface AgentSessionEvent {
  type: AgentSessionEventType;
  timestamp: number;
  runId: string;
  [key: string]: unknown;
}

/** Internal agent-session event emitted when the sandbox finalizes a message. */
export interface MessageCommittedEvent extends AgentSessionEvent {
  type: 'MESSAGE_COMMITTED';
  role: 'assistant' | 'tool';
  content: string;
  toolCalls?: ApiToolCallState[];
  toolCallId?: string;
  parts?: ApiMessagePart[];
  turnId: string;
  messageSeq: number;
}
