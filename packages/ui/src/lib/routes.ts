export const NEW_CONVERSATION_ROUTE = '/agents/:id/conversations/new';
export const CONVERSATION_ROUTE = '/agents/:id/conversations/:conversationId';

export function agentNewConversationPath(agentId: string): string {
  return `/agents/${agentId}/conversations/new`;
}

export function isNewConversationPath(pathname: string): boolean {
  return pathname.endsWith('/conversations/new');
}
