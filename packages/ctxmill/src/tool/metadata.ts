/**
 * Serializable tool metadata for gRPC transport between orchestrator and sandbox.
 *
 * ToolDefinition contains a handler closure and Zod schema — neither is
 * serializable. ToolMetadata is the wire-safe representation that can be
 * encoded into proto messages, sent over gRPC, and reconstituted on the
 * sandbox side via `jsonSchemaToZod`.
 */

import type { ToolDefinition } from './types.js';
import { zodToJsonSchema } from './schema-convert.js';

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Serializable representation of a tool definition suitable for gRPC transport.
 */
export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Where the tool executes — sandbox (default), orchestrator, or daemon. */
  location: 'sandbox' | 'orchestrator' | 'daemon';
  /** If true, the tool is available as a PTC script in /workspace/.tools/ */
  programmatic?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Conversion functions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Canonical resolver for tool execution location.
 * Every tool should set `location` explicitly; defaults to `'sandbox'`.
 */
export function resolveToolLocation(
  tool: Pick<ToolDefinition, 'location'>,
): 'sandbox' | 'orchestrator' | 'daemon' {
  return tool.location ?? 'sandbox';
}

/**
 * Convert a single ToolDefinition to its serializable ToolMetadata form.
 *
 * @param tool             - The tool definition containing a Zod input schema.
 * @param locationOverride - Execution location override.
 */
export function toToolMetadata(
  tool: ToolDefinition,
  locationOverride?: 'sandbox' | 'orchestrator' | 'daemon',
): ToolMetadata {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.input as any),
    location: locationOverride ?? resolveToolLocation(tool),
    programmatic: tool.programmatic ?? false,
  };
}

/**
 * Bulk-convert an array of ToolDefinitions to ToolMetadata.
 */
export function toToolMetadataList(tools: ToolDefinition[]): ToolMetadata[] {
  return tools.map((tool) => toToolMetadata(tool));
}
