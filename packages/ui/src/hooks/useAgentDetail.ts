import { useEffect, useState, useCallback } from 'react';
import { useAgentsStore } from '@/stores/agents';
import type { AgentSession } from '@/stores/agents';
import type { Agent } from '@/stores/agents';
import type { TabId } from '@/components/agent/types';

export interface UseAgentDetailReturn {
  agent: Agent | undefined;
  loading: boolean;
  agents: Agent[];
  error: string | null;

  allSessions: AgentSession[];
  sessionsLoading: boolean;
  loadSessions: () => Promise<void>;
}

export function useAgentDetail(id: string | undefined, activeTab: TabId): UseAgentDetailReturn {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const storeFetchSessions = useAgentsStore((s) => s.fetchSessions);

  const [allSessions, setAllSessions] = useState<AgentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Error state
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  const agent = agents.find((a) => a.id === id);

  const loadSessions = useCallback(async () => {
    if (!id) return;
    setSessionsLoading(true);
    setError(null);
    try {
      const sessions = await storeFetchSessions(id);
      setAllSessions(sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionsLoading(false);
    }
  }, [id, storeFetchSessions]);

  useEffect(() => {
    if (activeTab === 'sessions' || activeTab === 'overview') loadSessions();
  }, [activeTab, loadSessions]);

  return {
    agent,
    loading,
    agents,
    error,
    allSessions,
    sessionsLoading,
    loadSessions,
  };
}
