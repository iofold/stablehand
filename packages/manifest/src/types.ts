import type {
  AgentResourceLimits,
  ClaudeAgentsConfig,
  LangGraphConfig,
  PIAgentConfig,
} from '@ctxmill/contracts';

export interface ManifestMetadata {
  name: string;
  displayName?: string;
  description?: string;
  labels?: Record<string, string>;
}

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

export interface ManifestNativeTools {
  allowlist?: string[];
  blocklist?: string[];
}

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

export interface ManifestEmit {
  event: string;
  schema?: Record<string, unknown>;
}

export interface ManifestHITL {
  approvals?: ManifestApproval[];
}

export interface ManifestApproval {
  tool: string;
  when?: Record<string, unknown>;
  timeout?: number;
  fallback?: 'approve' | 'reject';
}

export interface ManifestFileCopy {
  src: string;
  dest: string;
}

export interface ManifestWorkspaceContent {
  files?: ManifestFileCopy[];
}

export interface ManifestWorkspace {
  content?: ManifestWorkspaceContent;
}

export interface ManifestResources {
  sandbox?: AgentResourceLimits;
}

export type ManifestMode = 'interactive' | 'background' | 'both';

interface ManifestSpecCommon {
  instructions: string;
  tools?: ManifestToolRef[];
  nativeTools?: ManifestNativeTools;
  triggers?: ManifestTrigger[];
  emits?: ManifestEmit[];
  hitl?: ManifestHITL;
  workspace?: ManifestWorkspace;
  resources?: ManifestResources;
  mode?: ManifestMode;
}

export interface LangGraphManifestSpec extends ManifestSpecCommon {
  harness: 'langgraph';
  harnessConfig: LangGraphConfig;
}

export interface ClaudeAgentsManifestSpec extends ManifestSpecCommon {
  harness: 'claude-agents';
  harnessConfig: ClaudeAgentsConfig;
}

export interface PIAgentManifestSpec extends ManifestSpecCommon {
  harness: 'pi-agent';
  harnessConfig: PIAgentConfig;
}

export type ManifestSpec =
  | LangGraphManifestSpec
  | ClaudeAgentsManifestSpec
  | PIAgentManifestSpec;

export interface AgentManifest {
  apiVersion: 'ctxmill.io/v1';
  kind: 'Agent';
  metadata: ManifestMetadata;
  spec: ManifestSpec;
}

export type ManifestHarnessConfig = ManifestSpec['harnessConfig'];
