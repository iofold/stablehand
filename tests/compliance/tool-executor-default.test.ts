/**
 * Compliance test runner for LocalFunctionExecutor.
 *
 * Verifies that the default (Level 1) tool executor implementation
 * satisfies the ToolExecutor behavioral contract defined in
 * tool-executor.compliance.ts.
 */

import { describe } from 'vitest';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import { runToolExecutorCompliance } from './tool-executor.compliance.js';

describe('LocalFunctionExecutor – compliance', () => {
  runToolExecutorCompliance(() => new LocalFunctionExecutor());
});
