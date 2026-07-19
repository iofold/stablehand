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

export interface HttpToolDefinition {
  name: string;
  description: string;
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  inputSchema?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
  authentication?: {
    type: 'bearer' | 'api-key';
    secretName: string;
    allowEnvFallback?: boolean;
  };
  programmatic?: boolean;
}

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
  /** Durable conversations (chat threads) for this agent. */
  conversationCount?: number;
  /** Execution turns (user-message → agent-response cycles) across all conversations. */
  turnCount?: number;
  /** Turns that finished without an error. */
  completedTurnCount?: number;
  /** Turns that ended with an error. */
  failedTurnCount?: number;
  /** Turns currently in flight (not yet completed). */
  activeTurnCount?: number;
  hasPendingInterrupt?: boolean;
  lastActivity?: number;
  /** Total tokens consumed by turns started in the trailing 24 hours. */
  tokensLast24h?: number;
  /** Total tokens consumed across all recorded turns. */
  tokensTotal?: number;
  /** The five most recently started turns. */
  recentTurns?: ApiAgentTurn[];
  systemPrompt?: string;
  /** Sandbox session (container) counts grouped by lifecycle state. */
  sandboxSessionsByStatus?: ApiSandboxSessionStatusCounts;
}

/** Sandbox session counts grouped by container lifecycle state. */
export type ApiSandboxSessionStatusCounts = Record<SandboxSessionStatus, number>;

/** One agent execution turn as returned by GET /api/agents/:id/turns. */
export interface ApiAgentTurn {
  id: string;
  agentId: string;
  conversationId: string;
  sandboxSessionId?: string;
  sandboxStatus?: SandboxSessionStatus;
  status: ApiTurnStatus;
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt?: number;
  error?: string;
  taskDescription?: string;
  conversationMessageCount?: number;
  restoreAttempts?: number | null;
  lastRestoreError?: string | null;
  checkpointAt?: number;
  usage?: ApiTokenUsage;
}

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
}

// ── Conversation Summary types ──────────────────────────────────

/** Enriched conversation as returned by GET /api/agents/:id/conversations/summary */
export interface ApiConversationSummary {
  id: string;
  agentId: string;
  status: ApiConversationStatus;
  mode: 'interactive' | 'background';
  turnCount: number;
  messageCount: number;
  taskDescription?: string;
  startedAt: number;
  /** Epoch ms when the latest turn reached a terminal state; unset while a turn is open. */
  completedAt?: number;
  updatedAt: number;
  latestTurnId?: string;
  sandboxSessionId?: string;
  /** Sum of harness-reported tokens across the conversation's turns. */
  totalTokens?: number;
}

/** Budget policy as returned by /api/budgets. */
export interface ApiBudgetPolicy {
  id: string;
  name: string;
  enabled: boolean;
  doc: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ApiBudgetSpendBucket {
  /** groupBy value, "(untagged)", or null for ungrouped policies. */
  bucket: string | null;
  spend: { totalTokens: number; costUsd: number; turns: number };
  statuses: Array<{ metric: 'totalTokens' | 'costUsd' | 'turns'; spent: number; limit: number; ratio: number }>;
}

/** Response of GET /api/budgets/:id/spend. */
export interface ApiBudgetSpend {
  policyId: string;
  window: string;
  windowStart: number;
  buckets: ApiBudgetSpendBucket[];
}

export interface ApiSandboxRestoreSuccess {
  sandboxSessionId: string;
  status: SandboxSessionStatus;
  restoreAttempts: 0;
}
