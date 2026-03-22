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
    
    const latestRunByConv = new Map<string, AgentRun>();
    for (const run of allRuns) {
      const convId = run.conversationId ?? 'unknown';
      const existing = latestRunByConv.get(convId);
      if (!existing || run.startedAt > existing.startedAt) {
        latestRunByConv.set(convId, run);
      }
    }
    
    const matchingConvIds = new Set<string>();
    for (const [convId, latestRun] of latestRunByConv.entries()) {
      if (latestRun.status === runsFilter) {
        matchingConvIds.add(convId);
      }
    }
    
    return allRuns.filter(r => matchingConvIds.has(r.conversationId ?? 'unknown'));
  }, [allRuns, runsFilter]);

  const totalRuns = allRuns.length;
  const activeRunsCount = allRuns.filter((r) => r.status === 'running' || r.status === 'queued').length;

  return { filteredRuns, totalRuns, activeRunsCount };
}
