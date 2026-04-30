import { useMemo } from 'react';
import type { AgentSession } from '@/stores/agents';
import { normalizeRunStatus } from '@/lib/session-status';

export interface UseAgentSessionsReturn {
  filteredSessions: AgentSession[];
}

export function useAgentSessions(allSessions: AgentSession[], sessionsFilter: string): UseAgentSessionsReturn {
  const filteredSessions = useMemo(() => {
    if (sessionsFilter === 'all') return allSessions;
    
    const latestSessionByConversation = new Map<string, AgentSession>();
    for (const session of allSessions) {
      const conversationId = session.conversationId ?? 'unknown';
      const existing = latestSessionByConversation.get(conversationId);
      if (!existing || session.startedAt > existing.startedAt) {
        latestSessionByConversation.set(conversationId, session);
      }
    }
    
    const matchingConversationIds = new Set<string>();
    for (const [conversationId, latestSession] of latestSessionByConversation.entries()) {
      if (normalizeRunStatus(latestSession.status) === sessionsFilter) {
        matchingConversationIds.add(conversationId);
      }
    }
    
    return allSessions.filter((session) => matchingConversationIds.has(session.conversationId ?? 'unknown'));
  }, [allSessions, sessionsFilter]);

  return { filteredSessions };
}
