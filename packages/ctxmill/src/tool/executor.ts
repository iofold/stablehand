import { randomUUID } from 'node:crypto';
import { tool as lcTool } from '@langchain/core/tools';
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
      return {
        callId: call.id,
        name: call.name,
        result: '',
        error: `Unknown tool: ${call.name}`,
        durationMs: 0,
      };
    }

    // Validate input with Zod
    const parsed = tool.input.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        callId: call.id,
        name: call.name,
        result: '',
        error: parsed.error.message,
        durationMs: 0,
      };
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
   * Convert registered tools to langchain StructuredTool[] format
   * for use with deepagents / LangGraph.
   */
  toLangChainTools(ctx: ToolContext) {
    return Array.from(this.tools.values()).map((def) => {
      return lcTool(
        async (args: Record<string, unknown>) => {
          const result = await this.execute(
            { id: randomUUID(), name: def.name, arguments: args },
            ctx,
          );
          if (result.error) throw new Error(result.error);
          return result.result;
        },
        {
          name: def.name,
          description: def.description,
          schema: def.input,
        },
      );
    });
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
        input_schema: zodToJsonSchema(tool.input),
      });
    }
    return result;
  }
}
