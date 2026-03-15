// Public API - factory functions
export { defineConfig } from './config/index.js';
export { defineAgent, AgentExecutor } from './agent/index.js';
export { defineTool, LocalFunctionExecutor } from './tool/index.js';

// Event bus
export { TypedEventBus } from './events/bus.js';

// Discovery
export { discoverAgents, discoverTools, discoverManifests } from './agent/discovery.js';

// Core types
export type {
  AgentDefinition,
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

// Config types
export type { CTXMillConfig, ResolvedConfig, Preset } from './config/types.js';

// Event types
export type {
  AGUIEventType,
  AGUIEvent,
  A2UIPayload,
  EventMap,
  EventName,
} from './events/types.js';
export type { PersistEventFn } from './events/bus.js';
export { waitForEvent, EventTimeoutError } from './events/wait-for-event.js';
export { SQLiteEventQueue } from './events/event-queue.js';
export type { EventQueue } from './events/event-queue.js';

// Event trigger system
export type { EventTrigger } from './events/triggers.js';
export { interpolateTemplate } from './events/triggers.js';
export { EventTriggerManager } from './events/trigger-manager.js';
export type { TriggerRunCallback } from './events/trigger-manager.js';

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

// Workspace types and implementations
export type {
  ExecutionEnvironment,
  ExecOptions,
  ExecResult,
  FileDiff,
  PromoteResult,
  EnvironmentFactory,
} from './workspace/index.js';
export { MockOverlayEnvironment, MockOverlayFactory } from './workspace/index.js';
export { FuseOverlayEnvironment, FuseOverlayFactory } from './workspace/index.js';
export { ensureAgentWorkspace, seedAgentWorkspace } from './workspace/index.js';

// Learning types and implementations
export type {
  ExecutionTrace,
  TraceStep,
  FeedbackSignal,
  Insight,
  LearningPipeline,
  LearningResult,
} from './learning/types.js';
export { TraceCollector } from './learning/trace.js';
export { SimpleReflector } from './learning/reflector.js';
export { DefaultLearningPipeline } from './learning/pipeline.js';

// Harness types and implementations
export type {
  AgentHarness, AgentEvent, AgentModelConfig, HarnessRunConfig,
  HarnessRegistry, ApprovalRequest, ApprovalResponse, TokenUsage,
  ResolvedSecrets,
} from './harness/index.js';
export { DefaultHarnessRegistry, LangGraphHarness, OpenAIAgentsHarness, ClaudeAgentsHarness, PIAgentHarness } from './harness/index.js';
export type { ToolProvider, ToolRegistry } from './tool/provider.js';
export { LocalToolProvider, MCPToolProvider, ComposioToolProvider } from './tool/providers/index.js';
export type { MCPTransportConfig, ComposioConfig } from './tool/providers/index.js';
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
