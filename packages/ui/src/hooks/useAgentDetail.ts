import { useEffect, useState, useCallback } from 'react';
import { useAgentsStore } from '@/stores/agents';
import type { AgentRun } from '@/stores/agents';
import type { Agent } from '@/stores/agents';
import {
  fetchKnowledgeStats,
  fetchKnowledge,
  fetchTraceStats,
  fetchFeedbackStats,
  fetchTraces,
} from '@/lib/api';
import type {
  KnowledgeItem,
  KnowledgeStats,
  TraceStats,
  FeedbackStats,
  Trace,
  TabId,
} from '@/components/agent/types';

export interface UseAgentDetailReturn {
  agent: Agent | undefined;
  loading: boolean;
  agents: Agent[];
  error: string | null;

  // Runs state
  allRuns: AgentRun[];
  runsLoading: boolean;
  loadRuns: () => Promise<void>;

  // Traces state
  traces: Trace[];

  // Overview learning dashboard state
  overviewKnowledgeItems: KnowledgeItem[];
  overviewKnowledgeStats: KnowledgeStats;
  traceStats: TraceStats;
  feedbackStats: FeedbackStats;
}

export function useAgentDetail(id: string | undefined, activeTab: TabId): UseAgentDetailReturn {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const storeFetchRuns = useAgentsStore((s) => s.fetchRuns);

  // Runs state
  const [allRuns, setAllRuns] = useState<AgentRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  // Learning dashboard state
  const [overviewKnowledgeItems, setOverviewKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [overviewKnowledgeStats, setOverviewKnowledgeStats] = useState<KnowledgeStats>({ totalItems: 0, categories: {} });
  const [traceStats, setTraceStats] = useState<TraceStats>({ total: 0, outcomes: {}, avgSteps: 0, recent24h: 0 });
  const [feedbackStats, setFeedbackStats] = useState<FeedbackStats>({ total: 0, types: {}, recent24h: 0 });

  // Error state
  const [error, setError] = useState<string | null>(null);

  // Traces state for runs tab
  const [traces, setTraces] = useState<Trace[]>([]);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  const agent = agents.find((a) => a.id === id);

  // Fetch runs when Sessions or Overview tab is active
  const loadRuns = useCallback(async () => {
    if (!id) return;
    setRunsLoading(true);
    setError(null);
    try {
      const runs = await storeFetchRuns(id);
      setAllRuns(Array.isArray(runs) ? runs : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunsLoading(false);
    }
  }, [id, storeFetchRuns]);

  useEffect(() => {
    if (activeTab === 'sessions' || activeTab === 'overview') loadRuns();
  }, [activeTab, loadRuns]);

  // Fetch traces when Sessions tab is active
  useEffect(() => {
    if (activeTab !== 'sessions' || !id) return;
    let mounted = true;
    setError(null);

    fetchTraces(id)
      .then((data) => {
        if (!mounted) return;
        setTraces(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => { mounted = false; };
  }, [activeTab, id]);

  // Fetch learning dashboard data when Overview tab is active
  useEffect(() => {
    if (activeTab !== 'overview' || !id) return;
    let mounted = true;
    setError(null);

    Promise.all([
      fetchKnowledgeStats(id),
      fetchKnowledge(id),
      fetchTraceStats(id),
      fetchFeedbackStats(id),
    ])
      .then(([kStats, kItems, tStats, fStats]) => {
        if (!mounted) return;
        setOverviewKnowledgeStats(kStats && typeof kStats === 'object' ? kStats as KnowledgeStats : { totalItems: 0, categories: {} });
        const kItemsArr: KnowledgeItem[] = Array.isArray(kItems) ? kItems : ((kItems as Record<string, unknown>)?.items as KnowledgeItem[] ?? []);
        setOverviewKnowledgeItems(kItemsArr.slice(0, 5));
        setTraceStats(tStats && typeof tStats === 'object' ? tStats as TraceStats : { total: 0, outcomes: {}, avgSteps: 0, recent24h: 0 });
        setFeedbackStats(fStats && typeof fStats === 'object' ? fStats as FeedbackStats : { total: 0, types: {}, recent24h: 0 });
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
    allRuns,
    runsLoading,
    loadRuns,
    traces,
    overviewKnowledgeItems,
    overviewKnowledgeStats,
    traceStats,
    feedbackStats,
  };
}
