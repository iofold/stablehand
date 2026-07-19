// Public API - factory functions
export { defineConfig } from './config/index.js';
export { defineAgent } from './agent/index.js';
export { defineTool, LocalFunctionExecutor } from './tool/index.js';

// Event bus
export { TypedEventBus } from './events/bus.js';

// Discovery
export { discoverAgents, discoverTools, discoverManifestProjects } from './agent/discovery.js';

// Core types
export type {
  AgentDefinition,
  AgentResourceLimits,
  AgentStatus,
  Agent,
  Message,
  Conversation,
} from '@ctxmill/sandbox-daemon';

// Tool types
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolContext,
} from '@ctxmill/sandbox-daemon';
export { createCtxmillGuideTool, CTXMILL_GUIDE_TOOL_NAME } from './tool/builtin/ctxmill-guide.js';

// Config types
export type { CTXMillConfig } from './config/types.js';

// Event types
export type {
  AgentSessionEventType,
  AgentSessionEvent,
} from './events/types.js';
export type { EventMap, EventName, PersistEventFn } from './events/bus.js';

// Event trigger system
export type { EventTrigger } from './events/triggers.js';
export { interpolateTemplate } from './events/triggers.js';
export { EventTriggerManager } from './events/trigger-manager.js';

export { ensureAgentWorkspace, seedAgentWorkspace } from './workspace/index.js';

// Harness types
export type {
  AgentHarness, AgentEvent,
  HarnessRegistry, ApprovalRequest, ApprovalResponse, TokenUsage,
  ResolvedSecrets, HarnessSession, HarnessSessionConfig, HarnessTurnInput,
  HarnessTurnContext, HarnessExportedState, HarnessRestorePoint,
} from './harness/index.js';
export type { ToolProvider } from './tool/provider.js';
export { LocalToolProvider, MCPToolProvider, ComposioToolProvider, HTTPToolProvider } from './tool/providers/index.js';
export type { MCPTransportConfig, ComposioConfig, HttpEndpointConfig, HttpAuthConfig } from './tool/providers/index.js';
export { DefaultToolRegistry } from './tool/registry.js';
export type { SecretProvider } from './secrets/index.js';

// Error utilities
export { getErrorMessage, isHttpError } from './util/errors.js';
export type { RetryOptions } from '@ctxmill/sandbox-daemon';
export { retryWithBackoff } from '@ctxmill/sandbox-daemon';
