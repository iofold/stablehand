// packages/ctxmill/src/workspace/index.ts — barrel export

export type {
  ExecutionEnvironment, ExecOptions, ExecResult,
  FileDiff, PromoteResult, EnvironmentFactory,
} from './types.js';
export { MockOverlayEnvironment, MockOverlayFactory } from './mock-overlay.js';
export { FuseOverlayEnvironment, FuseOverlayFactory } from './fuse-overlay.js';
export { ensureAgentWorkspace, seedAgentWorkspace } from './ensure.js';
