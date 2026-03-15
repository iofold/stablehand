import type { ToolDefinition } from '../types.js';
import { emitEventTool } from './emit-event.js';

/**
 * Built-in tools that are automatically available to all agents.
 * These are registered with the tool executor during container setup,
 * so agents do not need to list them in their `tools[]` array.
 */
export const builtinTools: ToolDefinition[] = [emitEventTool];

/**
 * Names of built-in tools that are automatically available to all agents.
 * Agents do not need to list these in their `tools[]` array.
 */
export const builtinToolNames: ReadonlySet<string> = new Set(
  builtinTools.map((t) => t.name),
);
