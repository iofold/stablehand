import type { ToolDefinition, ToolContext } from '@ctxmill/sandbox-daemon';

export interface ToolProvider {
  readonly name: string;
  listTools(): Promise<ToolDefinition[]>;
  execute?(toolName: string, args: unknown, ctx: ToolContext): Promise<string>;
}
