import type { ToolDefinition } from '@stablehand/sandbox-daemon';

export function defineTool(def: ToolDefinition): ToolDefinition {
  // Local tool handlers live in the orchestrator process; the sandbox only
  // ever sees a throwing placeholder for them (ctx-5xyo).
  return { location: 'orchestrator' as const, ...def };
}

export { LocalFunctionExecutor } from './executor.js';
export { discoverTools } from '../agent/discovery.js';
export { builtinTools, builtinToolNames } from './builtin/index.js';

// Tool provider interfaces
export type { ToolProvider } from './provider.js';

// Tool provider implementations
export { LocalToolProvider } from './providers/local.js';

// Tool registry
export { DefaultToolRegistry } from './registry.js';

// Schema conversion (Zod <-> JSON Schema for gRPC transport)
export { zodToJsonSchema, jsonSchemaToZod } from '@stablehand/sandbox-daemon';

// Tool metadata (serializable representation for gRPC transport)
export type { ToolMetadata } from './metadata.js';
export { resolveToolLocation, toToolMetadata, toToolMetadataList } from './metadata.js';
