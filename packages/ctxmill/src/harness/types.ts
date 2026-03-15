import type { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../tool/types.js';
import type { Message } from '../types.js';
import type { TypedEventBus } from '../events/bus.js';

export interface AgentModelConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKeyRef?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'off' | 'low' | 'medium' | 'high';
}

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

export interface HarnessRunConfig {
  modelConfig: AgentModelConfig;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  secrets: ResolvedSecrets;
  agentId: string;
  runId: string;
  conversationId: string;
  workspaceDir: string;
  eventBus?: TypedEventBus;
  onApprovalNeeded?: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string; args: unknown }
  | { type: 'tool_call_end'; id: string; result: string; error?: string; durationMs: number }
  | { type: 'approval_needed'; id: string; tool: string; args: unknown }
  | { type: 'approval_resolved'; id: string; action: 'approve' | 'reject' }
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
  run(config: HarnessRunConfig): AsyncGenerator<AgentEvent>;
}

export interface HarnessRegistry {
  register(harness: AgentHarness): void;
  get(name: string): AgentHarness;
  list(): string[];
}
