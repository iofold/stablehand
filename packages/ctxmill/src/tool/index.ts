import type { ToolDefinition } from './types.js';

export function defineTool(def: ToolDefinition): ToolDefinition {
  return { location: 'sandbox' as const, ...def };
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

// Schema conversion (Zod <-> JSON Schema for gRPC transport)
export { zodToJsonSchema, jsonSchemaToZod } from './schema-convert.js';

// Tool metadata (serializable representation for gRPC transport)
export type { ToolMetadata } from './metadata.js';
export { resolveToolLocation, toToolMetadata, toToolMetadataList } from './metadata.js';
