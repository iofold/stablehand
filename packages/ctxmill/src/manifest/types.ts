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
  model?: ManifestModelConfig;
  harnessConfig?: ManifestHarnessConfig;
  instructions: string;
  tools?: ManifestToolRef[];
  nativeTools?: ManifestNativeTools;
  triggers?: ManifestTrigger[];
  emits?: ManifestEmit[];
  hitl?: ManifestHITL;
  workspace?: ManifestWorkspace;
  resources?: ManifestResources;
  mode?: 'interactive' | 'background' | 'both';
}

export interface ManifestHarnessConfig {
  provider: string;
  model: string;
  apiKeyRef?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  baseUrl?: string;
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

export interface ManifestNativeTools {
  /** SDK-native tool names to allow. If set, only these are enabled. */
  allowlist?: string[];
  /** SDK-native tool names to deny. Applied after allowlist. */
  blocklist?: string[];
}

export interface ManifestFileCopy {
  src: string;
  dest: string;
}

export interface ManifestWorkspaceContent {
  /** Explicit files to copy into workspace before run */
  files?: ManifestFileCopy[];
  /**
   * true = auto-discover all skills; string[] = named skills only.
   * Skills are copied to .ctxmill/skills/ in workspace.
   */
  skills?: boolean | string[];
}

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
  content?: ManifestWorkspaceContent;
}

// ── Resources ───────────────────────────────────────────
export interface ManifestResources {
  maxSessionDurationSeconds?: number;
  maxTokensPerSession?: number;
  maxToolCallsPerRun?: number;
  costLimitPerDay?: number;
  /** Sandbox container resource limits. */
  sandbox?: ManifestSandboxResources;
}

export interface ManifestSandboxResources {
  /** CPU allocation in fractional cores. Range: 0.5 - 4.0 */
  cpus?: number;
  /** Memory limit in MiB. Range: 256 - 4096 */
  memoryMb?: number;
  /** PID limit. Range: 64 - 512 */
  pidsLimit?: number;
  /** Run timeout in seconds. Range: 60 - 3600 */
  timeoutSec?: number;
}
