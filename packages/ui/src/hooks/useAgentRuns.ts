import { useMemo } from 'react';
import type { AgentRun } from '@/stores/agents';

export interface UseAgentRunsReturn {
  filteredRuns: AgentRun[];
  totalRuns: number;
  activeRunsCount: number;
}

export function useAgentRuns(allRuns: AgentRun[], runsFilter: string): UseAgentRunsReturn {
  const filteredRuns = useMemo(() => {
    if (runsFilter === 'all') return allRuns;
    return allRuns.filter((r) => r.status === runsFilter);
  }, [allRuns, runsFilter]);

  const totalRuns = allRuns.length;
  const activeRunsCount = allRuns.filter((r) => r.status === 'running' || r.status === 'queued').length;

  return { filteredRuns, totalRuns, activeRunsCount };
}
