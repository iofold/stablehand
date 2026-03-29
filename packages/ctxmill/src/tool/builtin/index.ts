import type { ToolDefinition } from '../types.js';
import { a2uiRenderTool } from './a2ui-render.js';
import { emitEventTool } from './emit-event.js';
import { requestApprovalTool } from './request-approval.js';

export const builtinTools: ToolDefinition[] = [emitEventTool, requestApprovalTool, a2uiRenderTool];

/**
 * Names of built-in tools that are automatically available to all agents.
 * Agents do not need to list these in their `tools[]` array.
 */
export const builtinToolNames: ReadonlySet<string> = new Set(
  builtinTools.map((t) => t.name),
);
