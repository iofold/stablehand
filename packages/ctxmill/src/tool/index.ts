import type { z } from 'zod';
import type { ToolDefinition } from './types.js';

export function defineTool<T extends z.ZodType>(
  def: ToolDefinition<T>,
): ToolDefinition<T> {
  return def;
}

export { LocalFunctionExecutor } from './executor.js';
export { discoverTools } from '../agent/discovery.js';
