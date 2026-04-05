import type { ApiToolCallState, ApiMessagePart } from './api.js';

export type AGUIEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'RUN_FAILED'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'STATE_DELTA'
  | 'HITL_PAUSE'
  | 'MESSAGE_COMMITTED'
  | 'CUSTOM';

export interface AGUIEvent {
  type: AGUIEventType;
  timestamp: number;
  runId: string;
  [key: string]: unknown;
}

/** Emitted by the sandbox when a complete message has been finalized. */
export interface MessageCommittedEvent extends AGUIEvent {
  type: 'MESSAGE_COMMITTED';
  role: 'assistant' | 'tool';
  content: string;
  toolCalls?: ApiToolCallState[];
  toolCallId?: string;
  parts?: ApiMessagePart[];
  turnId: string;
  messageSeq: number;
}
