import { z } from 'zod';
import type { AGUIEvent } from '@ctxmill/shared';
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
  | { type: 'custom_agui_event'; event: AGUIEvent }
  | MessageCommittedAgentEvent
  | { type: 'error'; error: string }
  | { type: 'done'; result?: string; usage?: TokenUsage };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
}

export interface AgentHarness {
  readonly name: string;
  readonly configSchema: z.ZodType;
  openSession(config: HarnessSessionConfig, restore?: HarnessRestorePoint): Promise<HarnessSession>;
}

export interface HarnessSession {
  deliverTurn(input: HarnessTurnInput, context: HarnessTurnContext): AsyncGenerator<AgentEvent>;
  exportState(): Promise<HarnessExportedState>;
  close(): Promise<void>;
}

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

export interface HarnessRestorePoint {
  stateVersion: string;
  payload: Record<string, unknown>;
  messages: Message[];
}

export interface HarnessTurnInput {
  messages: Message[];
  turnId: string;
}

export interface HarnessTurnContext {
  signal?: AbortSignal;
  onApprovalNeeded?: ApprovalCallback;
}

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
