import { useEffect, useState, useCallback } from 'react';
import { useAgentsStore } from '@/stores/agents';
import type { AgentTurn } from '@/stores/agents';
import type { Agent } from '@/stores/agents';
import type { TabId } from '@/components/agent/types';

export interface UseAgentDetailReturn {
  agent: Agent | undefined;
  loading: boolean;
  agents: Agent[];
  error: string | null;

  allTurns: AgentTurn[];
  turnsLoading: boolean;
  loadTurns: () => Promise<void>;
}

export function useAgentDetail(id: string | undefined, activeTab: TabId): UseAgentDetailReturn {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const storeFetchTurns = useAgentsStore((s) => s.fetchTurns);

  const [allTurns, setAllTurns] = useState<AgentTurn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);

  // Error state
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  const agent = agents.find((a) => a.id === id);

  const loadTurns = useCallback(async () => {
    if (!id) return;
    setTurnsLoading(true);
    setError(null);
    try {
      const turns = await storeFetchTurns(id);
      setAllTurns(turns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTurnsLoading(false);
    }
  }, [id, storeFetchTurns]);

  useEffect(() => {
    if (activeTab === 'turns' || activeTab === 'overview') loadTurns();
  }, [activeTab, loadTurns]);

  return {
    agent,
    loading,
    agents,
    error,
    allTurns,
    turnsLoading,
    loadTurns,
  };
}
