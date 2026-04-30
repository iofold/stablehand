import { useEffect, useState, useCallback } from 'react';
import { useAgentsStore } from '@/stores/agents';
import type { AgentSession } from '@/stores/agents';
import type { Agent } from '@/stores/agents';
import {
  fetchKnowledgeStats,
  fetchKnowledge,
} from '@/lib/api';
import type {
  KnowledgeItem,
  KnowledgeStats,
  TabId,
} from '@/components/agent/types';

export interface UseAgentDetailReturn {
  agent: Agent | undefined;
  loading: boolean;
  agents: Agent[];
  error: string | null;

  allSessions: AgentSession[];
  sessionsLoading: boolean;
  loadSessions: () => Promise<void>;

  // Overview knowledge state
  overviewKnowledgeItems: KnowledgeItem[];
  overviewKnowledgeStats: KnowledgeStats;
}

export function useAgentDetail(id: string | undefined, activeTab: TabId): UseAgentDetailReturn {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const storeFetchSessions = useAgentsStore((s) => s.fetchSessions);

  const [allSessions, setAllSessions] = useState<AgentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Overview knowledge state
  const [overviewKnowledgeItems, setOverviewKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [overviewKnowledgeStats, setOverviewKnowledgeStats] = useState<KnowledgeStats>({ totalItems: 0, categories: {} });

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

  // Fetch overview knowledge data when Overview tab is active
  useEffect(() => {
    if (activeTab !== 'overview' || !id) return;
    let mounted = true;
    setError(null);

    Promise.all([
      fetchKnowledgeStats(id),
      fetchKnowledge(id),
    ])
      .then(([kStats, kItems]) => {
        if (!mounted) return;
        setOverviewKnowledgeStats(kStats && typeof kStats === 'object' ? kStats as KnowledgeStats : { totalItems: 0, categories: {} });
        const kItemsArr: KnowledgeItem[] = Array.isArray(kItems) ? kItems : ((kItems as Record<string, unknown>)?.items as KnowledgeItem[] ?? []);
        setOverviewKnowledgeItems(kItemsArr.slice(0, 5));
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => { mounted = false; };
  }, [activeTab, id]);

  return {
    agent,
    loading,
    agents,
    error,
    allSessions,
    sessionsLoading,
    loadSessions,
    overviewKnowledgeItems,
    overviewKnowledgeStats,
  };
}
