import type { ToolCall } from './tool/types.js';
import type { A2UIPayload } from './events/types.js';

// Resource limit configuration for sandbox containers
export interface AgentResourceLimits {
  /** CPU allocation in fractional cores. Range: 0.5 - 4.0, default: 1.0 */
  cpus?: number;
  /** Memory limit in MiB. Range: 256 - 4096, default: 512 */
  memoryMb?: number;
  /** PID limit for the container. Range: 64 - 512, default: 256 */
  pidsLimit?: number;
  /** Run timeout in seconds. Range: 60 - 3600, default: 600 */
  timeoutSec?: number;
}

export interface NativeToolConfig {
  allowlist?: string[];
  blocklist?: string[];
}

// Agent types
export interface AgentDefinition {
  name: string;
  harness: string;
  harnessConfig: Record<string, unknown>;
  tools: string[];
  nativeTools?: NativeToolConfig;
  systemPrompt: string;
  description?: string;
  metadata?: Record<string, unknown>;
  mode?: 'interactive' | 'background' | 'both';
  workspaceDir?: string;
  workspaceContent?: {
    files?: Array<{ src: string; dest: string }>;
    skills?: boolean | string[];
  };
  /** Directory where agent manifest was loaded from. Used to resolve relative paths. */
  projectDir?: string;
  resourceLimits?: AgentResourceLimits;
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
