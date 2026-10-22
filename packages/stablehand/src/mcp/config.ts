import { createHash } from 'node:crypto';

import {
  McpServerDefinitionSchema,
  type McpServerDefinition,
} from '@stablehand/contracts';

/**
 * Agent-facing MCP tool names are `<server>__<tool>`: the double underscore
 * matches Claude Code's `mcp__server__tool` convention and keeps tools from
 * two servers apart.
 */
export const MCP_TOOL_NAME_SEPARATOR = '__';

/**
 * Model APIs cap tool names at 64 characters, and the Claude harness adds a
 * 17-character `mcp__stablehand__` prefix, so agent-facing names stay at 47.
 */
export const MAX_AGENT_TOOL_NAME_LENGTH = 47;

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000;

/** Upper bound on one tool result handed back to the model, in characters. */
export const MAX_MCP_RESULT_CHARS = 100_000;

export function mcpProviderName(agentId: string, serverName: string): string {
  return `mcp-${agentId}-${serverName}`;
}

export function mcpProviderPrefix(agentId: string): string {
  return `mcp-${agentId}-`;
}

/** Valid MCP server declarations stored on an agent; malformed entries are dropped. */
export function getAgentMcpServers(metadata: Record<string, unknown> | null | undefined): McpServerDefinition[] {
  const raw = metadata?.mcpServers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = McpServerDefinitionSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** `*` matches any run of characters; everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`);
}

export function matchesAnyGlob(name: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(name));
}

/** Whether the server declaration lets the agent see this tool. */
export function isMcpToolAllowed(server: McpServerDefinition, mcpToolName: string): boolean {
  if (!server.tools || server.tools.length === 0) return true;
  return matchesAnyGlob(mcpToolName, server.tools);
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  title?: string;
}

/**
 * The operator's `requireApproval` wins. Without one, a tool the server marks
 * destructive (and not read-only) waits for approval. Annotations come from
 * the server and are only hints, so they set the default, never override.
 */
export function mcpToolRequiresApproval(
  server: McpServerDefinition,
  mcpToolName: string,
  annotations: McpToolAnnotations | undefined,
): boolean {
  if (server.requireApproval === true) return true;
  if (server.requireApproval === false) return false;
  if (Array.isArray(server.requireApproval)) {
    return matchesAnyGlob(mcpToolName, server.requireApproval);
  }
  return annotations?.destructiveHint === true && annotations.readOnlyHint !== true;
}

/** `<server>__<tool>`, restricted to `[A-Za-z0-9_-]` and 47 characters. */
export function agentToolName(serverName: string, mcpToolName: string): string {
  const safe = mcpToolName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  const full = `${serverName}${MCP_TOOL_NAME_SEPARATOR}${safe}`;
  if (full.length <= MAX_AGENT_TOOL_NAME_LENGTH) {
    return full;
  }
  // Long names keep a readable head plus a short hash of the original so two
  // long tools cannot collide.
  const hash = createHash('sha256').update(mcpToolName).digest('hex').slice(0, 6);
  return `${full.slice(0, MAX_AGENT_TOOL_NAME_LENGTH - 7)}_${hash}`;
}

/** `list_meetings` / `apify/rag-web-browser` / `getMeetings` → "List meetings" etc. */
export function humanizeMcpToolName(mcpToolName: string): string {
  const base = mcpToolName.includes('/') ? mcpToolName.slice(mcpToolName.lastIndexOf('/') + 1) : mcpToolName;
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return mcpToolName;
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
