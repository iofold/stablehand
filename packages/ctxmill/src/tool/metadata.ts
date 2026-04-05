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
/*  Orchestrator-bound tools                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Tool names that always run on the orchestrator side regardless of the
 * location hint. These tools need access to orchestrator-only resources
 * (event bus, HITL approval queues, etc.) and cannot execute in a sandbox.
 */
export const ORCHESTRATOR_TOOLS: ReadonlySet<string> = new Set([
  'emit-event',
  'request-approval',
  'a2ui-render',
  'ctxmill-guide',
]);

export const DAEMON_TOOLS: ReadonlySet<string> = new Set([
  'artifact_upload',
  'artifact_download',
]);

/* -------------------------------------------------------------------------- */
/*  Conversion functions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Convert a single ToolDefinition to its serializable ToolMetadata form.
 *
 * @param tool     - The tool definition containing a Zod input schema.
 * @param location - Execution location override. When omitted the function
 *                   checks whether `tool.name` is in {@link ORCHESTRATOR_TOOLS};
 *                   if so it is `'orchestrator'`, otherwise `'sandbox'`.
 */
export function toToolMetadata(
  tool: ToolDefinition,
  location?: 'sandbox' | 'orchestrator' | 'daemon',
): ToolMetadata {
  const resolvedLocation =
    location
    ?? tool.location
    ?? (ORCHESTRATOR_TOOLS.has(tool.name) || tool.requiresApproval
      ? 'orchestrator'
      : DAEMON_TOOLS.has(tool.name)
        ? 'daemon'
        : 'sandbox');

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.input as any),
    location: resolvedLocation,
    programmatic: tool.programmatic ?? false,
  };
}

/**
 * Bulk-convert an array of ToolDefinitions to ToolMetadata.
 *
 * Location is auto-detected per tool based on {@link ORCHESTRATOR_TOOLS}.
 */
export function toToolMetadataList(tools: ToolDefinition[]): ToolMetadata[] {
  return tools.map((tool) => toToolMetadata(tool));
}
