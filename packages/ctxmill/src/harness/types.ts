import { z } from 'zod';
import type { ToolDefinition } from '../tool/types.js';
import type { Message, NativeToolConfig } from '../types.js';

export type ResolvedSecrets = Record<string, string>;

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ApprovalResponse {
  action: 'approve' | 'reject';
  data?: unknown;
}

export type ApprovalCallback = (req: ApprovalRequest) => Promise<ApprovalResponse>;

// ── Agent Events ────────────────────────────────────────────────

export interface MessageCommittedAgentEvent {
  type: 'message_committed';
  role: Message['role'];
  content: string;
  toolCalls?: Message['toolCalls'];
  toolCallId?: Message['toolCallId'];
  turnId: string;
  messageSeq: number;
}

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string; args: unknown }
  | { type: 'tool_call_end'; id: string; result: string; error?: string; durationMs: number }
  | { type: 'approval_needed'; id: string; tool: string; args: unknown }
  | { type: 'approval_resolved'; id: string; action: 'approve' | 'reject' }
  | MessageCommittedAgentEvent
  | { type: 'error'; error: string }
  | { type: 'done'; result?: string; usage?: TokenUsage };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
}

// ── Session-based Harness Interface ─────────────────────────────

/**
 * Harness implementation that opens a persistent session for one conversation.
 */
export interface AgentHarness {
  readonly name: string;
  readonly configSchema: z.ZodType;
  openSession(config: HarnessSessionConfig, restore?: HarnessRestorePoint): Promise<HarnessSession>;
}

/**
 * Live harness session that accepts turns, can export opaque state, and must be closed.
 */
export interface HarnessSession {
  deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent>;
  exportState(): Promise<HarnessExportedState>;
  close(): Promise<void>;
}

/**
 * Immutable configuration used when opening a harness session.
 */
export interface HarnessSessionConfig {
  agentId: string;
  conversationId: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  nativeTools?: NativeToolConfig[];
  secrets: ResolvedSecrets;
  workspaceDir: string;
  harnessConfigJson: string;
  signal?: AbortSignal;
  onApprovalNeeded?: ApprovalCallback;
}

/**
 * Serializable restore payload plus previously committed conversation history.
 */
export interface HarnessRestorePoint {
  stateVersion: string;
  payload: Record<string, unknown>;
  messages: Message[];
}

/**
 * Input for a single delivered turn, usually containing only new user/tool messages.
 */
export interface HarnessTurnInput {
  messages: Message[];
  turnId: string;
}

/**
 * Per-turn execution context such as cancellation and approval handling.
 */
export interface HarnessTurnContext {
  signal?: AbortSignal;
  onApprovalNeeded?: ApprovalCallback;
}

/**
 * Opaque harness-managed state snapshot safe to persist outside the harness.
 */
export interface HarnessExportedState {
  stateVersion: string;
  payload: Record<string, unknown>;
}

export interface HarnessRegistry {
  register(harness: AgentHarness): void;
  get(name: string): AgentHarness;
  getConfigSchema(name: string): z.ZodType;
  list(): string[];
}
