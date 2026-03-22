import type { ToolDefinition, ToolCall, ToolResult, ToolContext } from './types.js';
import { zodToJsonSchema } from '../util/zod-to-json-schema.js';

export class LocalFunctionExecutor {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      const available = Array.from(this.tools.keys()).join(', ');
      throw new Error(`Unknown tool: "${call.name}". Available tools: ${available}`);
    }

    const zodInput = tool.input as import('zod').ZodType;
    const parsed = zodInput.safeParse(call.arguments);
    if (!parsed.success) {
      throw new Error(`Tool "${call.name}" input validation failed: ${parsed.error.message}`);
    }

    const start = performance.now();
    try {
      const result = await tool.handler(parsed.data, ctx);
      return {
        callId: call.id,
        name: call.name,
        result,
        durationMs: performance.now() - start,
      };
    } catch (err) {
      return {
        callId: call.id,
        name: call.name,
        result: '',
        error: String(err),
        durationMs: performance.now() - start,
      };
    }
  }

  /**
   * Convert registered tools to a JSON Schema format suitable for
   * generic LLM APIs (provider-agnostic).
   */
  toJsonSchemaFormat(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    const result: Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }> = [];
    for (const tool of this.tools.values()) {
      result.push({
        name: tool.name,
        description: tool.description,
        input_schema: zodToJsonSchema(tool.input as any),
      });
    }
    return result;
  }
}
