import type { ToolDefinition, ToolContext } from '@stablehand/sandbox-daemon';

/**
 * Where a provider's tools come from, as the catalog reports it. Providers
 * declare this; nothing infers it from a tool's name (ctx-z08z).
 */
export type ToolSourceKind = 'local' | 'http' | 'mcp';

/** Catalog presentation for one tool, supplied by the provider that serves it. */
export interface ToolCatalogInfo {
  /** Plain label for people, e.g. "List meetings". */
  displayName?: string;
  /** Server or endpoint group the tool belongs to, e.g. "granola". */
  server?: string;
}

export interface ToolProvider {
  readonly name: string;
  /** Defaults to `local` when a provider does not say. */
  readonly source?: ToolSourceKind;
  /**
   * When set, the provider's tools belong to this one agent: other agents
   * never see them, and lookups for this agent prefer them.
   */
  readonly agentScope?: string;
  /**
   * When true (agent-scoped providers only), every tool the provider lists is
   * offered to its agent without being named in the agent's `tools` list.
   * MCP servers use this: the server declaration and its allowlist decide.
   */
  readonly attachAll?: boolean;
  listTools(): Promise<ToolDefinition[]>;
  execute?(toolName: string, args: unknown, ctx: ToolContext): Promise<string>;
  catalogInfo?(tool: ToolDefinition): ToolCatalogInfo | undefined;
}
