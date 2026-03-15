// ── Envelope ────────────────────────────────────────────
export interface AgentManifest {
  apiVersion: 'ctxmill.io/v1';
  kind: 'Agent';
  metadata: ManifestMetadata;
  spec: ManifestSpec;
}

export interface ManifestMetadata {
  name: string;
  displayName?: string;
  description?: string;
  labels?: Record<string, string>;
}

// ── Spec ────────────────────────────────────────────────
export interface ManifestSpec {
  harness: string;
  model: ManifestModelConfig;
  instructions: string;
  tools?: ManifestToolRef[];
  triggers?: ManifestTrigger[];
  emits?: ManifestEmit[];
  hitl?: ManifestHITL;
  workspace?: ManifestWorkspace;
  resources?: ManifestResources;
  mode?: 'interactive' | 'background' | 'both';
}

export interface ManifestModelConfig {
  provider: string;
  id: string;
  apiKeyRef?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  baseUrl?: string;
}

// ── Tool References ─────────────────────────────────────
export type ManifestToolRef =
  | { ref: string }
  | { mcp: ManifestMCPTool }
  | { inline: ManifestInlineTool };

export interface ManifestMCPTool {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface ManifestInlineTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

// ── Triggers ────────────────────────────────────────────
export interface ManifestTrigger {
  event?: string;
  filter?: Record<string, unknown>;
  input?: Record<string, string>;
  schedule?: ManifestSchedule;
}

export interface ManifestSchedule {
  cron: string;
  description?: string;
}

// ── Emits ───────────────────────────────────────────────
export interface ManifestEmit {
  event: string;
  schema?: Record<string, unknown>;
}

// ── HITL ────────────────────────────────────────────────
export interface ManifestHITL {
  approvals?: ManifestApproval[];
}

export interface ManifestApproval {
  tool: string;
  when?: Record<string, unknown>;
  timeout?: number;
  fallback?: 'approve' | 'reject';
}

// ── Workspace ───────────────────────────────────────────
export interface ManifestWorkspace {
  snapshotRef?: string;
  maxSizeBytes?: number;
  readOnlyPaths?: string[];
  writablePaths?: string[];
}

// ── Resources ───────────────────────────────────────────
export interface ManifestResources {
  maxRunDurationSeconds?: number;
  maxTokensPerRun?: number;
  maxToolCallsPerRun?: number;
  costLimitPerDay?: number;
}
