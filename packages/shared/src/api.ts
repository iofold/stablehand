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

// ctx-iqzy S18: @stablehand/contracts is the sole declaration of these wire
// shapes. `z.input` gives the producer-side (unbranded) view, so internal
// serializers keep assigning plain strings.
import type { z } from 'zod';
import type {
  MessagePartSchema,
  MessageSchema,
  ToolCallStateSchema,
} from '@stablehand/contracts';

/** Message inside a GET /api/agents/:id/conversations/:cid/snapshot response. */
export type ApiMessage = z.input<typeof MessageSchema>;

/** Ordered content part within a message. Preserves text ↔ tool_call interleaving. */
export type ApiMessagePart = z.input<typeof MessagePartSchema>;

/** Tool call state tracked during streaming. */
export type ApiToolCallState = z.input<typeof ToolCallStateSchema>;

/** A2UI component block rendered via the a2ui-render tool */
export interface ApiA2UIBlock {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

/**
 * HITL interrupt payload on the agent SSE stream (INTERRUPT_REQUEST). Not an
 * entity mirror: the durable interrupt entity is contracts InterruptSchema
 * (PK `id`), while this event payload keeps `interruptId` as a cross-ref.
 */
export interface ApiInterruptPayload {
  interruptId: string;
  turnId: string;
  agentId: string;
  toolName: string;
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
