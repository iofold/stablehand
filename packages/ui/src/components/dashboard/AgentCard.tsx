import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import type { Agent } from '@/stores/agents';

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  const navigate = useNavigate();

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'bg-status-success';
      case 'booting':
        return 'bg-status-warning';
      case 'error':
        return 'bg-status-error';
      default:
        return 'bg-surface-600';
    }
  };

  const getStatusBorderColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'border-t-2 border-t-emerald-500/30';
      case 'booting':
        return 'border-t-2 border-t-yellow-500/30';
      case 'error':
        return 'border-t-2 border-t-red-500/30';
      default:
        return 'border-t-2 border-t-surface-600/30';
    }
  };

  const capabilities = [
    { label: 'tools', count: agent.tools.length },
    { label: 'subagents', count: agent.subagents?.length ?? 0 },
    { label: 'skills', count: agent.skills?.length ?? 0 },
    { label: 'knowledge', count: agent.knowledgeItems ?? 0 },
    { label: 'mounts', count: agent.workspaceDir ? 1 : 0 },
  ].filter((c) => c.count > 0);

  const metrics = [
    `${agent.activeRuns ?? 0} runs`,
    `${agent.sseClients ?? 0} connections`,
  ];

  return (
    <button
      type="button"
      data-testid="agent-card"
      onClick={() => navigate(`/agents/${agent.id}`)}
      className={cn(
        'group w-full text-left rounded-lg border border-surface-700',
        'bg-gradient-to-b from-surface-800 to-surface-800/60',
        getStatusBorderColor(agent.status),
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-surface-500'
      )}
    >
      <div className="p-4 flex flex-col gap-3">
        {/* Header Row: Status Dot + Agent Name and Model Name */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={cn(
                'w-1.5 h-1.5 rounded-full flex-shrink-0',
                getStatusColor(agent.status)
              )}
            />
            <h3
              data-testid="agent-name"
              className="text-base font-semibold text-surface-200 truncate"
            >
              {agent.name}
            </h3>
          </div>
          <span className="font-mono text-xs text-surface-400 flex-shrink-0">
            {agent.model}
          </span>
        </div>

        {/* Description: 2-line max */}
        {agent.description && (
          <p className="text-sm text-surface-400 line-clamp-2">
            {agent.description}
          </p>
        )}

        {/* Capabilities/Skills: Tiny tags */}
        {capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {capabilities.map((cap) => (
              <span
                key={cap.label}
                className="badge border-surface-700"
              >
                {cap.count} {cap.label}
              </span>
            ))}
          </div>
        )}

        {/* Bottom metrics: Tabular nums with separators */}
        <div className="text-xs text-surface-400 tabular-nums">
          {metrics.join(' · ')}
        </div>
      </div>
    </button>
  );
}
