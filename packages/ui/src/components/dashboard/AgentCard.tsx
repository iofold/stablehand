import { useNavigate } from 'react-router-dom';
import { MessageSquare, Settings, AlertCircle, Activity, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Agent } from '@/stores/agents';

interface AgentCardProps {
  agent: Agent;
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return 'Never';
  const diff = Date.now() - timestamp;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AgentCard({ agent }: AgentCardProps) {
  const navigate = useNavigate();

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'running':
        return 'bg-status-success shadow-[0_0_8px_rgba(16,185,129,0.6)]';
      case 'booting':
        return 'bg-status-warning shadow-[0_0_8px_rgba(245,158,11,0.6)]';
      case 'error':
        return 'bg-status-error shadow-[0_0_8px_rgba(239,68,68,0.6)]';
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
    { label: 'native tools', count: agent.nativeTools?.allowlist?.length ?? agent.nativeTools?.blocklist?.length ?? 0 },
    { label: 'knowledge', count: agent.knowledgeItems ?? 0 },
    { label: 'workspace', count: agent.workspaceDir ? 1 : 0 },
  ].filter((c) => c.count > 0);

  const metrics = [
    `${agent.totalRuns ?? agent.runs?.length ?? 0} runs`,
    `${agent.conversationCount ?? 0} chats`,
    `${agent.sseClients ?? 0} connections`,
  ];

  return (
    <div
      data-testid="agent-card"
      className={cn(
        'group relative w-full text-left rounded-lg border border-surface-700',
        'bg-gradient-to-b from-surface-800 to-surface-800/60',
        getStatusBorderColor(agent.status),
        'transition-all duration-200 hover:border-surface-600 hover:shadow-lg hover:shadow-black/20'
      )}
    >
      <div className="p-4 flex flex-col gap-3">
        {/* Header Row: Status Dot + Agent Name and Model Name */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={cn(
                'w-2.5 h-2.5 rounded-full flex-shrink-0',
                getStatusColor(agent.status)
              )}
              aria-label={`Status: ${agent.status}`}
            />
            <h3
              data-testid="agent-name"
              className="text-base font-semibold text-surface-200 truncate"
              title={agent.name}
            >
              {agent.name}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {agent.harness && (
              <span className="rounded bg-surface-700/60 px-1.5 py-0.5 text-[10px] font-medium text-surface-300 uppercase tracking-wider">
                {agent.harness}
              </span>
            )}
            <span className="font-mono text-xs text-surface-400">
              {(agent.harnessConfig as Record<string, unknown>)?.model as string ?? agent.harness}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {agent.hasPendingInterrupt && (
            <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 border border-orange-500/30 px-2 py-0.5 text-[11px] font-medium text-orange-400">
              <AlertCircle className="h-3 w-3" />
              Approval Needed
            </span>
          )}
          {(agent.activeRuns ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
              <Activity className="h-3 w-3" />
              {agent.activeRuns} Active
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] text-surface-400 ml-auto">
            <Clock className="h-3 w-3" />
            {formatRelativeTime(agent.lastActivity)}
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
                className="inline-flex items-center rounded-full bg-surface-800/60 border border-surface-700 px-2 py-0.5 text-[11px] text-surface-400"
              >
                {cap.count} {cap.label}
              </span>
            ))}
          </div>
        )}

        {/* Bottom metrics: Tabular nums with separators */}
        <div className="text-xs text-surface-400 tabular-nums mt-1">
          {metrics.join(' · ')}
        </div>
      </div>

      <div className="absolute inset-0 flex items-center justify-center gap-3 bg-surface-900/80 backdrop-blur-[2px] opacity-0 transition-opacity duration-200 group-hover:opacity-100 rounded-lg">
        <button
          type="button"
          onClick={() => navigate(`/agents/${agent.id}/chat`)}
          className="flex items-center gap-2 rounded-md bg-accent-600 px-4 py-2 text-sm font-medium text-white hover:bg-accent-500 transition-colors shadow-lg"
        >
          <MessageSquare className="h-4 w-4" />
          Chat
        </button>
        <button
          type="button"
          onClick={() => navigate(`/agents/${agent.id}`)}
          className="flex items-center gap-2 rounded-md bg-surface-700 px-4 py-2 text-sm font-medium text-surface-100 hover:bg-surface-600 transition-colors shadow-lg"
        >
          <Settings className="h-4 w-4" />
          Details
        </button>
      </div>
    </div>
  );
}
