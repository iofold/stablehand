// Public API - factory functions
export { defineConfig } from './config/index.js';
export { defineAgent } from './agent/index.js';
export { defineTool, LocalFunctionExecutor } from './tool/index.js';

// Event bus
export { TypedEventBus } from './events/bus.js';

// Discovery
export { discoverAgents, discoverTools, discoverManifests } from './agent/discovery.js';

// Core types
export type {
  AgentDefinition,
  AgentResourceLimits,
  AgentStatus,
  Agent,
  Message,
  Conversation,
} from './types.js';

// Tool types
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolContext,
} from './tool/types.js';
export { createCtxmillGuideTool, CTXMILL_GUIDE_TOOL_NAME } from './tool/builtin/ctxmill-guide.js';

// Config types
export type { CTXMillConfig, ResolvedConfig, Preset } from './config/types.js';

// Event types
export type {
  AGUIEventType,
  AGUIEvent,
  EventMap,
  EventName,
} from './events/types.js';
export type { PersistEventFn } from './events/bus.js';
export { waitForEvent, EventTimeoutError } from './events/wait-for-event.js';

// Event trigger system
export type { EventTrigger } from './events/triggers.js';
export { interpolateTemplate } from './events/triggers.js';
export { EventTriggerManager } from './events/trigger-manager.js';

// Knowledge types and implementations
export type {
  KnowledgeItem,
  ContextItem,
  ContextQuery,
  ContextResult,
  KnowledgeStore,
  ContextProvider,
} from './knowledge/types.js';
export { InMemoryKnowledgeStore } from './knowledge/store.js';
export { InMemoryContextProvider } from './knowledge/context.js';

export { ensureAgentWorkspace, seedAgentWorkspace } from './workspace/index.js';

// Harness types and implementations
export type {
  AgentHarness, AgentEvent,
  HarnessRegistry, ApprovalRequest, ApprovalResponse, TokenUsage,
  ResolvedSecrets, HarnessSession, HarnessSessionConfig, HarnessTurnInput,
  HarnessTurnContext, HarnessExportedState, HarnessRestorePoint,
} from './harness/index.js';
export { DefaultHarnessRegistry, LangGraphHarness, ClaudeAgentsHarness, PIAgentHarness } from './harness/index.js';
export type { ToolProvider, ToolRegistry } from './tool/provider.js';
export { LocalToolProvider, MCPToolProvider, ComposioToolProvider, HTTPToolProvider } from './tool/providers/index.js';
export type { MCPTransportConfig, ComposioConfig, HttpEndpointConfig, HttpAuthConfig } from './tool/providers/index.js';
export { DefaultToolRegistry } from './tool/registry.js';
export type { SecretProvider } from './secrets/index.js';

// Manifest types and service
export type {
  AgentManifest, ManifestMetadata, ManifestSpec, ManifestModelConfig,
  ManifestToolRef, ManifestTrigger, ManifestEmit, ManifestHITL,
  ManifestWorkspace, ManifestResources,
} from './manifest/index.js';
export { ManifestService, validateManifest, parseManifestString, serializeManifestYAML,
  manifestToDefinition, definitionToManifest } from './manifest/index.js';

// Error utilities
export { getErrorMessage, isHttpError } from './util/errors.js';
export type { RetryOptions } from './util/retry.js';
export { retryWithBackoff } from './util/retry.js';
