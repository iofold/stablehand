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
  callbackUrl?: string | null;
  /** Per-agent resource limits for sandbox containers. */
  resourceLimits?: ApiAgentResourceLimits | null;
  metadata?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  version?: number;
  sseClients?: number;
  conversationCount?: number;
  hasPendingInterrupt?: boolean;
  lastActivity?: number;
  activeRuns?: number;
  totalRuns?: number;
  runs?: ApiAgentRun[];
  systemPrompt?: string;
}

/** Run as returned by GET /api/agents/:id/runs */
export interface ApiAgentRun {
  id: string;
  agentId: string;
  conversationId: string;
  status: 'queued' | 'running' | 'paused' | 'suspended' | 'completed' | 'error' | 'cancelled';
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt?: number;
  error?: string;
  taskDescription?: string;
}

/** Message as returned by GET /api/agents/:id/conversations/:cid/messages */
export interface ApiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ApiToolCallState[];
  a2uiBlocks?: ApiA2UIBlock[];
  createdAt: string;
}

/** Tool call state tracked during streaming */
export interface ApiToolCallState {
  id: string;
  name: string;
  args: string;
  result?: string;
  error?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
}

/** A2UI component block */
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
  runId?: string;
}

/** POST /api/agents/:id/feedback request body */
export interface ApiFeedbackRequest {
  conversationId: string;
  messageId: string;
  type: 'thumbs_up' | 'thumbs_down';
}

/** Knowledge item as returned by GET /api/agents/:id/knowledge */
export interface ApiKnowledgeItem {
  id: string;
  content: string;
  category: string;
  source: string;
  createdAt: string;
  relevance: number;
}

// ── Skill types (Agent Skills Standard / SKILL.md format) ───────────

/** Parsed YAML frontmatter from a SKILL.md file */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  'allowed-tools'?: string;
}

/** Lightweight manifest entry returned by skill discovery */
export interface SkillManifestEntry {
  name: string;
  description: string;
  path: string;
  source: 'project' | 'personal' | 'plugin' | 'marketplace';
}

/** Full skill data including parsed SKILL.md and directory contents */
export interface LoadedSkill extends SkillManifestEntry {
  frontmatter: SkillFrontmatter;
  instructions: string;
  scripts: string[];
  references: string[];
  assets: string[];
}

/** Result of validating a loaded skill */
export interface SkillValidationResult {
  valid: boolean;
  errors: string[];
}

/** Legacy skill (raw .ts/.js file without SKILL.md) */
export interface LegacySkill {
  name: string;
  filename: string;
  content: string;
  legacy: true;
}

/** Knowledge stats as returned by GET /api/agents/:id/knowledge/stats */
export interface ApiKnowledgeStats {
  totalItems: number;
  categories: Record<string, number>;
  recentItems: number;
  oldestItem?: string;
  newestItem?: string;
}

/** Shared knowledge item with agentId field */
export interface ApiSharedKnowledgeItem extends ApiKnowledgeItem {
  agentId: string;
}

// ── Sandbox Session types ───────────────────────────────────────

export type SandboxSessionStatus = 'ACTIVE' | 'FROZEN' | 'CHECKPOINTED' | 'RESTORING';

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
