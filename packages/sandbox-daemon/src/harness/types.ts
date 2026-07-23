import { z } from 'zod';
import type { AgentSessionEvent } from '@ctxmill/shared';
import type { NativeToolPolicy } from '@ctxmill/contracts';
import type { ToolDefinition } from '../tool/types.js';
import type { Message } from '../types.js';
import type {
  HarnessEnforcementCapabilities,
  HarnessTurnEnforcer,
} from './enforcement/types.js';

export type ResolvedSecrets = Record<string, string>;

export interface ApprovalRequest {
  id: string;
  turnId: string;
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
  | { type: 'custom_agui_event'; event: AgentSessionEvent }
  | MessageCommittedAgentEvent
  | { type: 'error'; error: string }
  | { type: 'done'; result?: string; usage?: TokenUsage };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface AgentHarness {
  readonly name: string;
  readonly configSchema: z.ZodType;
  readonly enforcementCapabilities: HarnessEnforcementCapabilities;
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
  nativeToolPolicy?: NativeToolPolicy;
  secrets: ResolvedSecrets;
  workspaceDir: string;
  harnessConfigJson: string;
  turnEnforcer?: HarnessTurnEnforcer;
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
  turnSecrets?: Readonly<Record<string, string>>;
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
