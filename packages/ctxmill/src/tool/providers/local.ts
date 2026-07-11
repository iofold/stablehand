import type { ToolProvider } from '../provider.js';
import type { ToolDefinition, ToolContext } from '@ctxmill/sandbox-daemon';
import { LocalFunctionExecutor } from '../executor.js';

/**
 * Wraps the existing LocalFunctionExecutor in the ToolProvider interface,
 * allowing locally-registered tools to participate in the unified tool registry.
 */
export class LocalToolProvider implements ToolProvider {
  readonly name = 'local';
  private executor: LocalFunctionExecutor;

  constructor(executor: LocalFunctionExecutor) {
    this.executor = executor;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.executor.list();
  }

  async execute(toolName: string, args: unknown, ctx: ToolContext): Promise<string> {
    const result = await this.executor.execute(
      { id: '', name: toolName, arguments: args as Record<string, unknown> },
      ctx,
    );
    if (result.error) {
      throw new Error(result.error);
    }
    return result.result;
  }
}
