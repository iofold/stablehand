import type { z } from 'zod';
import type { ToolDefinition } from './types.js';

export function defineTool<T extends z.ZodType>(
  def: ToolDefinition<T>,
): ToolDefinition<T> {
  return def;
}

export { LocalFunctionExecutor } from './executor.js';
export { discoverTools } from '../agent/discovery.js';
export { builtinTools, builtinToolNames } from './builtin/index.js';

// Tool provider interfaces
export type { ToolProvider, ToolRegistry } from './provider.js';

// Tool provider implementations
export { LocalToolProvider } from './providers/local.js';
export { MCPToolProvider } from './providers/mcp.js';
export type { MCPTransportConfig } from './providers/mcp.js';
export { ComposioToolProvider } from './providers/composio.js';
export type { ComposioConfig } from './providers/composio.js';

// Tool registry
export { DefaultToolRegistry } from './registry.js';
