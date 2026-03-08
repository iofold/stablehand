// Public API - factory functions
export { defineConfig } from './config/index.js';
export { defineAgent, AgentExecutor } from './agent/index.js';
export { defineTool, LocalFunctionExecutor } from './tool/index.js';

// Re-export deepagents for power users
export { createDeepAgent } from 'deepagents';

// Event bus
export { TypedEventBus } from './events/bus.js';

// Discovery
export { discoverAgents, discoverTools } from './agent/discovery.js';

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
  InternalEventType,
  InternalEvent,
} from './events/types.js';

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

// Learning types and implementations
export type {
  ExecutionTrace,
  TraceStep,
  FeedbackSignal,
  Insight,
  LearningPipeline,
} from './learning/types.js';
export { TraceCollector } from './learning/trace.js';
export { SimpleReflector } from './learning/reflector.js';
export type { ReflectorConfig } from './learning/reflector.js';
export { DefaultLearningPipeline } from './learning/pipeline.js';
