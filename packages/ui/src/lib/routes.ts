export const NEW_CONVERSATION_ROUTE = '/agents/:id/conversations/new';
export const CONVERSATION_ROUTE = '/agents/:id/conversations/:conversationId';
export const LEGACY_NEW_SESSION_ROUTE = '/agents/:id/sessions/new';
export const LEGACY_SESSION_ROUTE = '/agents/:id/sessions/:conversationId';
export const LEGACY_CHAT_ROUTE = '/agents/:id/chat';

export function agentNewConversationPath(agentId: string): string {
  return `/agents/${agentId}/conversations/new`;
}

export function agentLegacyNewSessionPath(agentId: string): string {
  return `/agents/${agentId}/sessions/new`;
}

export function isNewConversationPath(pathname: string): boolean {
  return pathname.endsWith('/conversations/new') || pathname.endsWith('/sessions/new');
}
