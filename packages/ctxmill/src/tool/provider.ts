import type { ToolDefinition, ToolContext } from './types.js';

export interface ToolProvider {
  readonly name: string;
  listTools(): Promise<ToolDefinition[]>;
  execute?(toolName: string, args: unknown, ctx: ToolContext): Promise<string>;
}

export interface ToolRegistry {
  addProvider(provider: ToolProvider): void;
  removeProvider(name: string): void;
  listAll(): ToolDefinition[];
  listForAgent(declaredToolNames: string[], agentId?: string): ToolDefinition[];
  getProvider(toolName: string, agentId?: string): ToolProvider | undefined;
}
