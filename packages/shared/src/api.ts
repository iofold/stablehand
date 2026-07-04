/** Resource limits for sandbox containers as returned in agent API responses. */
export interface ApiAgentResourceLimits {
  /** CPU allocation in fractional cores. Range: 0.5 - 4.0, default: 1.0 */
  cpus?: number;
  /** Memory limit in MiB. Range: 256 - 4096, default: 512 */
  memoryMb?: number;
  /** PID limit for the container. Range: 64 - 512, default: 256 */
  pidsLimit?: number;
  /** Run timeout in seconds. Range: 60 - 3600, default: 600 */
  timeoutSec?: number;
}

export const API_SESSION_STATUSES = [
  'QUEUED',
  'ACTIVE',
  'CHECKPOINTED',
  'RESTORING',
  'TERMINATED',
  'COMPLETED',
  'ERROR',
  'CANCELLED',
  'IDLE',
] as const;

export type ApiSessionStatus = typeof API_SESSION_STATUSES[number];
export type SandboxSessionStatus = Extract<ApiSessionStatus, 'ACTIVE' | 'CHECKPOINTED' | 'RESTORING' | 'TERMINATED'>;

/** Agent as returned by GET /api/agents and GET /api/agents/:id */
export interface ApiAgent {
  id: string;
  name: string;
  status: string;
  description?: string;
  tools: string[];
  harness: string;
  harnessConfig: Record<string, unknown>;
  workspaceDir?: string | null;
  /** Per-agent resource limits for sandbox containers. */
  resourceLimits?: ApiAgentResourceLimits | null;
  metadata?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  version?: number;
  sseClients?: number;
  conversationCount?: number;
  hasPendingInterrupt?: boolean;
  lastActivity?: number;
  activeSessions?: number;
  totalSessions?: number;
  sessions?: ApiAgentSession[];
  systemPrompt?: string;
  /** Sandbox session counts grouped by lifecycle state. */
  sessionsByStatus?: ApiSessionStatusCounts;
}

/** Session counts grouped by sandbox lifecycle state. */
export type ApiSessionStatusCounts = Record<SandboxSessionStatus, number>;

/** Session as returned by GET /api/agents/:id/sessions */
export interface ApiAgentSession {
  id: string;
  agentId: string;
  conversationId: string;
  sandboxSessionId?: string;
  sandboxStatus?: SandboxSessionStatus;
  status: ApiSessionStatus;
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt?: number;
  error?: string;
  taskDescription?: string;
  messageCount?: number;
  restoreAttempts?: number | null;
  lastRestoreError?: string | null;
  checkpointAt?: number;
}

/** Message as returned by GET /api/agents/:id/conversations/:cid/messages */
export interface ApiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ApiToolCallState[];
  parts?: ApiMessagePart[];
  createdAt: string;
}

/** Ordered content part within a message. Preserves text ↔ tool_call interleaving. */
export type ApiMessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string; result?: string; error?: string; status: ApiToolCallState['status'] };

/** Tool call state tracked during streaming */
export interface ApiToolCallState {
  id: string;
  name: string;
  args: string;
  result?: string;
  error?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
}

/** A2UI component block rendered via the a2ui-render tool */
export interface ApiA2UIBlock {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

/** HITL interrupt payload */
export interface ApiInterruptPayload {
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
  sessionId?: string;
}

/** POST /api/agents/:id/feedback request body */
export interface ApiFeedbackRequest {
  conversationId: string;
  messageId: string;
  type: 'thumbs_up' | 'thumbs_down';
}

// ── Conversation Summary types ──────────────────────────────────

/** Enriched conversation as returned by GET /api/agents/:id/conversations/summary */
export interface ApiConversationSummary {
  id: string;
  agentId: string;
  status: ApiSessionStatus;
  mode: 'interactive' | 'background';
  turnCount: number;
  messageCount: number;
  taskDescription?: string;
  startedAt: number;
  updatedAt: number;
  latestTurnId?: string;
  sandboxSessionId?: string;
}

// ── Sandbox Session types ───────────────────────────────────────

/** Persistent sandbox session as returned by sandbox session APIs. */
export interface ApiSandboxSession {
  id: string;
  conversationId: string;
  agentId: string;
  status: SandboxSessionStatus;
  containerName?: string;
  harnessName: string;
  createdAt: string;
  lastActivityAt: string;
  restoreAttempts?: number | null;
  lastRestoreError?: string | null;
}

export interface ApiSandboxRestoreSuccess {
  sessionId: string;
  status: SandboxSessionStatus;
  restoreAttempts: 0;
}

export interface ApiSandboxRestoreError {
  error: 'Restore failed';
  code: 'restore_failed';
  category: 'retryable' | 'non_retryable';
  detail: string;
  status: SandboxSessionStatus | 'TERMINATED';
  restoreAttempts: number | null;
  sessionId: string;
}

/** Session turn as returned by sandbox session turn APIs. */
export interface ApiSessionTurn {
  turnId: string;
  sessionId: string;
  status: 'pending' | 'in_flight' | 'completed' | 'error';
  messageCount: number;
  startedAt?: string;
  completedAt?: string;
}
