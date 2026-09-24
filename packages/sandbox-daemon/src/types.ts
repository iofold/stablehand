import type { ToolCall } from './tool/types.js';
import type { BuiltinToolPolicy, NativeToolPolicy } from '@stablehand/contracts';
export interface AgentResourceLimits {
  cpus?: number;
  memoryMb?: number;
  pidsLimit?: number;
  timeoutSec?: number;
}

export interface AgentDefinition {
  name: string;
  harness: string;
  harnessConfig: Record<string, unknown>;
  tools: string[];
  builtinToolPolicy?: BuiltinToolPolicy;
  nativeToolPolicy?: NativeToolPolicy;
  systemPrompt: string;
  description?: string;
  metadata?: Record<string, unknown>;
  mode?: 'interactive' | 'background' | 'both';
  workspaceDir?: string;
  workspaceContent?: {
    files?: Array<{ src: string; dest: string }>;
  };
  projectDir?: string;
  resourceLimits?: AgentResourceLimits;
}

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

export interface Message {
  id: string;
  agentId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  createdAt: Date;
}

export interface Conversation {
  id: string;
  agentId: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}
