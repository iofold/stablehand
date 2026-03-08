import type { z } from 'zod';

export interface ToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: TInput;
  requiresApproval?: boolean;
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<string>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  result: string;
  error?: string;
  durationMs: number;
}

export interface ToolContext {
  agentId: string;
  conversationId: string;
  knowledge: {
    query: (opts: {
      text: string;
      limit?: number;
    }) => Promise<{
      items: Array<{ id: string; content: string; score: number }>;
    }>;
  };
}
