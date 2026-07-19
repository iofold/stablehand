export interface ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  requiresApproval?: boolean;
  location?: 'sandbox' | 'orchestrator' | 'daemon';
  programmatic?: boolean;
  secrets?: string[];
  timeout?: number;
  handler: (input: unknown, ctx: ToolContext) => Promise<string>;
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
  turnId?: string;
  sandboxSessionId?: string;
  requestId?: string;
  workspaceDir: string;
  eventBus?: {
    emit(event: string, payload: unknown): void;
    emitCustom(event: string, agentId: string, payload: unknown): void;
  };
}
