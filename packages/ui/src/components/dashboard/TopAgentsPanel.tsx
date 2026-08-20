import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AnalyticsAgentActivity } from '@ctxmill/contracts';
import { formatCompactNumber } from '@/lib/format';
import { harnessLabel } from '@/lib/harness';
import { RelativeTime } from '@/components/ui/RelativeTime';

export interface TopAgentsPanelProps {
  agents: AnalyticsAgentActivity[];
  loading?: boolean;
  windowLabel: string;
}

/** Most-active agents in the analytics window; rows navigate to the agent. */
export function TopAgentsPanel({ agents, loading, windowLabel }: TopAgentsPanelProps) {
  const navigate = useNavigate();
  const top = useMemo(
    () => [...agents]
      .filter((agent) => agent.turns > 0)
      .sort((a, b) => b.turns - a.turns)
      .slice(0, 6),
    [agents],
  );

  return (
    <div className="rounded-lg border border-surface-700 bg-surface-800/30 p-4" data-testid="top-agents-panel">
      <h3 className="mb-3 text-sm font-medium text-surface-300">Most active agents · {windowLabel}</h3>
      {loading && top.length === 0 ? (
        <div className="py-8 text-center text-sm text-surface-500">Loading…</div>
      ) : top.length === 0 ? (
        <div className="py-8 text-center text-sm text-surface-500">No runs in this window.</div>
      ) : (
        <ul className="divide-y divide-surface-700/50">
          {top.map((agent) => {
            const errorRate = agent.turns > 0 ? agent.errorTurns / agent.turns : 0;
            return (
              <li key={agent.agentId}>
                <button
                  type="button"
                  onClick={() => navigate(`/agents/${agent.agentId}`)}
                  className="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-surface-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-surface-200">{agent.name}</div>
                    <div className="text-xs text-surface-500">
                      {harnessLabel(agent.harness)}
                      {agent.lastActivityAt !== null && (
                        <> · <RelativeTime timestamp={agent.lastActivityAt} /></>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-sm tabular-nums text-surface-300">
                    {formatCompactNumber(agent.turns)} runs
                    <div className="text-xs text-surface-500">
                      {errorRate > 0
                        ? <span className="text-red-400">{Math.round(errorRate * 100)}% err</span>
                        : 'no errors'}
                      {agent.knownCostUsd > 0 && <> · ${agent.knownCostUsd.toFixed(2)}</>}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
