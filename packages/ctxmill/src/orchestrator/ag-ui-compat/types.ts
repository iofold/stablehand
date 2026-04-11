export interface AGUIRunAgentInput {
  threadId: string;
  runId: string;
  state?: unknown;
  messages: AGUIMessage[];
  tools?: AGUITool[];
  context?: AGUIContext[];
  forwardedProps?: unknown;
}

export type AGUIMessageRole = 'developer' | 'system' | 'assistant' | 'user' | 'tool';

export interface AGUIMessage {
  id: string;
  role: AGUIMessageRole;
  content?: string;
  name?: string;
  toolCallId?: string;
}

export interface AGUITool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface AGUIContext {
  description: string;
  value: string;
}

export interface AGUIProtocolEvent {
  type: string;
  timestamp?: number;
  runId?: string;
  threadId?: string;
  [key: string]: unknown;
}
