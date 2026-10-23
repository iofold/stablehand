import type {
  AgentEgress,
  AgentResourceLimits,
  BuiltinToolPolicy,
  ClaudeAgentsConfig,
  LangGraphConfig,
  McpServerDefinition,
  NativeToolPolicy,
  PIAgentConfig,
} from '@stablehand/contracts';

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

/**
 * Legacy per-tool MCP entry. Rejected at conversion: declare servers under
 * `spec.mcpServers` instead (one entry per server, not per tool).
 */
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

export type ManifestNativeToolPolicy = NativeToolPolicy;
export type ManifestBuiltinToolPolicy = BuiltinToolPolicy;

export interface ManifestTrigger {
  event?: string;
  filter?: Record<string, unknown>;
  input?: Record<string, string>;
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

/** A remote MCP server the agent may call; the orchestrator runs the client. */
export type ManifestMcpServer = McpServerDefinition;

/**
 * Where the agent's sandboxes may connect: `default` (the server allowlist), `deny` (only the
 * model provider and runtime services, plus `rules`) or `allow` (the server allowlist plus `rules`).
 */
export type ManifestEgress = AgentEgress;

interface ManifestSpecCommon {
  instructions: string;
  tools?: ManifestToolRef[];
  mcpServers?: ManifestMcpServer[];
  /** Budget-attribution tags stamped on every run of this agent (metadata.defaultTags). */
  defaultTags?: Record<string, string>;
  builtinToolPolicy?: ManifestBuiltinToolPolicy;
  nativeToolPolicy?: ManifestNativeToolPolicy;
  triggers?: ManifestTrigger[];
  emits?: ManifestEmit[];
  hitl?: ManifestHITL;
  workspace?: ManifestWorkspace;
  resources?: ManifestResources;
  mode?: ManifestMode;
  egress?: ManifestEgress;
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
  apiVersion: 'stablehand.io/v1';
  kind: 'Agent';
  metadata: ManifestMetadata;
  spec: ManifestSpec;
}

export type ManifestHarnessConfig = ManifestSpec['harnessConfig'];
