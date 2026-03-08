/** Agent as returned by GET /api/agents and GET /api/agents/:id */
export interface ApiAgent {
  id: string;
  name: string;
  status: string;
  description?: string;
  tools: string[];
  model: string;
  sseClients?: number;
  conversationCount?: number;
  hasPendingInterrupt?: boolean;
  lastActivity?: number;
  activeRuns?: number;
  runs?: ApiAgentRun[];
  systemPrompt?: string;
}

/** Run as returned by GET /api/agents/:id/runs */
export interface ApiAgentRun {
  id: string;
  agentId: string;
  conversationId: string;
  status: 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
  mode: 'interactive' | 'background';
  startedAt: number;
  completedAt?: number;
  error?: string;
  taskDescription?: string;
}

/** Message as returned by GET /api/agents/:id/conversations/:cid/messages */
export interface ApiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ApiToolCallState[];
  a2uiBlocks?: ApiA2UIBlock[];
  createdAt: string;
}

/** Tool call state tracked during streaming */
export interface ApiToolCallState {
  id: string;
  name: string;
  args: string;
  result?: string;
  error?: string;
  status: 'pending' | 'running' | 'complete' | 'error';
}

/** A2UI component block */
export interface ApiA2UIBlock {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

/** HITL interrupt payload */
export interface ApiInterruptPayload {
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId: string;
}

/** POST /api/agents/:id/feedback request body */
export interface ApiFeedbackRequest {
  conversationId: string;
  messageId: string;
  type: 'thumbs_up' | 'thumbs_down';
}

/** Knowledge item as returned by GET /api/agents/:id/knowledge */
export interface ApiKnowledgeItem {
  id: string;
  content: string;
  category: string;
  source: string;
  createdAt: string;
  relevance: number;
}

/** Knowledge stats as returned by GET /api/agents/:id/knowledge/stats */
export interface ApiKnowledgeStats {
  totalItems: number;
  categories: Record<string, number>;
  recentItems: number;
  oldestItem?: string;
  newestItem?: string;
}
