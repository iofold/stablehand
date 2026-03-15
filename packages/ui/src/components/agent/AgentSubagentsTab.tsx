import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GitBranch,
  ChevronRight,
} from 'lucide-react';

export interface AgentSubagentsTabProps {
  agent: { id: string; name: string; metadata?: Record<string, unknown>; subagents?: string[] };
  agents: { id: string; name: string; status: string }[];
}

export function AgentSubagentsTab({ agent, agents }: AgentSubagentsTabProps) {
  const navigate = useNavigate();
  const subagentIds = agent.subagents || (agent.metadata?.subagents as string[]) || [];
  const [showHint, setShowHint] = useState(false);

  return (
    <div data-testid="subagents-tab-content" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-surface-100">Configured Subagents</h2>
        <div className="flex items-center gap-2">
          {showHint && (
            <span className="text-xs text-surface-400">Use the Edit button in the header to add subagents.</span>
          )}
          <button
            type="button"
            onClick={() => setShowHint(true)}
            className="flex items-center gap-1.5 rounded-lg border border-surface-700/50 bg-surface-800 px-3 py-1.5 text-sm font-medium text-surface-300 hover:bg-surface-700 hover:text-surface-100 transition-colors"
          >
            <GitBranch className="h-3.5 w-3.5" />
            Add Subagent
          </button>
        </div>
      </div>

      {subagentIds.length === 0 ? (
        <div className="text-center py-16">
          <GitBranch className="mx-auto h-10 w-10 text-surface-700 mb-3" />
          <p className="text-surface-400 font-medium">No subagents configured</p>
          <p className="text-surface-600 text-sm mt-1 max-w-md mx-auto">
            Subagents let this agent delegate tasks to specialized child agents.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {subagentIds.map((subId) => {
            const matched = agents.find((a) => a.id === subId);
            return (
              <div key={subId} className="rounded-lg border border-surface-700/30 bg-surface-800/40 overflow-hidden">
                <button
                  type="button"
                  onClick={() => navigate(`/agents/${subId}`)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-800 cursor-pointer text-left"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <GitBranch className="h-4 w-4 text-surface-500 flex-shrink-0" />
                    <span className="font-medium text-surface-200 truncate">
                      {matched?.name || subId}
                    </span>
                    {matched && (
                      <span className="flex items-center gap-1.5 text-xs text-surface-400 capitalize">
                        <span className={`h-2 w-2 rounded-full ${
                          matched.status === 'running' ? 'bg-accent-500' :
                          matched.status === 'error' ? 'bg-red-500' :
                          'bg-surface-500'
                        }`} />
                        {matched.status}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-6 flex-shrink-0 text-xs text-surface-500">
                    <div className="hidden sm:flex flex-col items-end">
                      <span className="text-[10px] uppercase tracking-wider text-surface-600">ID / Ref</span>
                      <span className="font-mono">{subId}</span>
                    </div>
                    <ChevronRight className="h-4 w-4 text-surface-600" />
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
