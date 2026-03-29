import { useMemo } from 'react';
import type { AgentSession } from '@/stores/agents';

export interface UseAgentSessionsReturn {
  filteredSessions: AgentSession[];
  totalSessions: number;
  activeSessionsCount: number;
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
      if (latestSession.status === sessionsFilter) {
        matchingConversationIds.add(conversationId);
      }
    }
    
    return allSessions.filter((session) => matchingConversationIds.has(session.conversationId ?? 'unknown'));
  }, [allSessions, sessionsFilter]);

  const totalSessions = allSessions.length;
  const activeSessionsCount = allSessions.filter((session) => session.status === 'running' || session.status === 'queued').length;

  return { filteredSessions, totalSessions, activeSessionsCount };
}
