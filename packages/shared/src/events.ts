import type { ApiToolCallState } from './api.js';

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
  /** Message role: 'assistant' or 'tool'. */
  role: 'assistant' | 'tool';
  /** Full message content. */
  content: string;
  /** Tool calls included in this message, if any. */
  toolCalls?: ApiToolCallState[];
  /** Tool call ID this message responds to, if role is 'tool'. */
  toolCallId?: string;
  /** Turn within the session that produced this message. */
  turnId: string;
  /** Monotonic sequence number within the session. */
  messageSeq: number;
}
