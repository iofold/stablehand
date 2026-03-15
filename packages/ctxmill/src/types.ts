import type { ToolCall } from './tool/types.js';
import type { A2UIPayload } from './events/types.js';
import type { AgentModelConfig } from './harness/types.js';

// Agent types
export interface AgentDefinition {
  name: string;
  model: string;                    // kept for backward compat
  harness?: string;                 // 'langgraph' | 'openai-agents' | 'claude-agents' | 'pi-agent' | 'vercel-ai'
  modelConfig?: AgentModelConfig;
  tools: string[];
  systemPrompt: string;
  description?: string;
  metadata?: Record<string, unknown>;
  mode?: 'interactive' | 'background' | 'both';
  workspaceDir?: string;
}

// Agent runtime state
export type AgentStatus =
  | 'created'
  | 'booting'
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'error'
  | 'terminated';

export interface Agent {
  id: string;
  definition: AgentDefinition;
  status: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Conversation types
export interface Message {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  a2uiPayload?: A2UIPayload;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  agentId: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}
