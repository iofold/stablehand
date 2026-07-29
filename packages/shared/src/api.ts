export const API_TURN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'ERROR',
  'CANCELLED',
] as const;

export const API_CONVERSATION_STATUSES = [
  'ACTIVE',
  'CHECKPOINTED',
  'RESTORING',
  'COMPLETED',
  'ERROR',
  'CANCELLED',
  'IDLE',
] as const;

export const SANDBOX_SESSION_STATUSES = [
  'ACTIVE',
  'CHECKPOINTED',
  'RESTORING',
  'TERMINATED',
] as const;

export type ApiTurnStatus = typeof API_TURN_STATUSES[number];
export type ApiConversationStatus = typeof API_CONVERSATION_STATUSES[number];
export type SandboxSessionStatus = typeof SANDBOX_SESSION_STATUSES[number];

/** Normalized LLM token usage for a turn, as reported by the harness at done. */
export interface ApiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider-reported cost in USD when the harness supplies it. */
  costUsd?: number;
}

/** Sandbox session counts grouped by container lifecycle state. */
export type ApiSandboxSessionStatusCounts = Record<SandboxSessionStatus, number>;

/** Message inside a GET /api/agents/:id/conversations/:cid/snapshot response. */
export interface ApiMessage {
  id: string;
  conversationId?: string;
  agentId?: string;
  turnId?: string;
  messageSeq?: number;
  messageRevision: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ApiToolCallState[];
  parts?: ApiMessagePart[];
  createdAt: string | number;
}

/** Ordered content part within a message. Preserves text ↔ tool_call interleaving. */
export type ApiMessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string; result?: string; error?: string; status: ApiToolCallState['status']; durationMs?: number };

/** Tool call state tracked during streaming */
export interface ApiToolCallState {
  id: string;
  name: string;
  args: string;
  result?: string;
  error?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  /** Harness-measured execution time; absent when the harness does not report one. */
  durationMs?: number;
}

/** A2UI component block rendered via the a2ui-render tool */
export interface ApiA2UIBlock {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

/** HITL interrupt payload */
export interface ApiInterruptPayload {
  interruptId: string;
  turnId: string;
  agentId: string;
  toolCallName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  sandboxSessionId?: string;
}

/** POST /api/agents/:id/feedback request body */
export interface ApiFeedbackRequest {
  conversationId: string;
  messageId: string;
  type: 'thumbs_up' | 'thumbs_down';
  /** Optional free-text comment; preserved verbatim on the feedback.received event. */
  comment?: string;
}

export interface ApiSandboxRestoreSuccess {
  sandboxSessionId: string;
  status: SandboxSessionStatus;
  restoreAttempts: 0;
}
