export interface WaitCondition {
  id: string;
  sessionId: string;
  agentId: string;
  eventType: string;
  selector: Record<string, unknown>;
  expiresAt?: number;
  contextSnapshot: {
    conversationId: string;
    lastMessageId?: string;
    metadata?: Record<string, unknown>;
  };
  createdAt: number;
}

export function matchesSelector(
  payload: Record<string, unknown>,
  selector: Record<string, unknown>,
): boolean {
  return Object.entries(selector).every(([k, v]) => payload[k] === v);
}
