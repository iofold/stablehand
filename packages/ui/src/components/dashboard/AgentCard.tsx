import { useNavigate } from 'react-router-dom';
import { MessageSquare, Settings, AlertCircle, Activity, Clock, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAgentStatusConfig } from '@/lib/agent-status';
import { agentLegacyNewSessionPath } from '@/lib/routes';
import { countActiveSessions, countAllSessions, describeSessionCounts } from '@/lib/session-status';
import type { Agent } from '@/stores/agents';
import { AgentAvatar } from './illustrations/AgentAvatar';
import { StatusPulse } from './illustrations/StatusPulse';
import { AnimatedCounter } from './MicroInteractions';

interface AgentCardProps {
  agent: Agent;
  onEdit?: (agent: Agent) => void;
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

type DashboardStatus = 'running' | 'error' | 'idle';

function getDashboardStatus(agent: Agent, activeSessionCount: number): DashboardStatus {
  const status = agent.status.toLowerCase();
  if (status === 'error') return 'error';
  if (status === 'running' || status === 'booting' || activeSessionCount > 0) return 'running';
  return 'idle';
}

function formatAgentStatusLabel(status: DashboardStatus): string {
  const labels: Record<DashboardStatus, string> = {
    error: 'Error',
    idle: 'Idle',
    running: 'Running',
  };
  return labels[status];
}

export function AgentCard({ agent, onEdit }: AgentCardProps) {
  const navigate = useNavigate();

  const activeSessionCount = countActiveSessions(agent.sessionsByStatus);
  const dashboardStatus = getDashboardStatus(agent, activeSessionCount);
  const statusConfig = getAgentStatusConfig(dashboardStatus);
  const statusLabel = formatAgentStatusLabel(dashboardStatus);

  const totalTools = agent.tools.length + (agent.nativeTools?.allowlist?.length ?? agent.nativeTools?.blocklist?.length ?? 0);

  const renderSessions = () => {
    const stats = agent.sessionsByStatus;
    const total = countAllSessions(stats);
    if (!stats || total === 0) {
      return <span className="tabular-nums font-medium text-surface-200">0</span>;
    }

    const title = describeSessionCounts(stats);

    return (
      <div role="status" aria-label={`${total} sessions: ${title}`} className="flex items-center gap-2 tabular-nums font-medium text-surface-200" title={title}>
        {stats.ACTIVE > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            {stats.ACTIVE}
          </span>
        )}
        {stats.RESTORING > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400"></span>
            {stats.RESTORING}
          </span>
        )}
        {stats.CHECKPOINTED > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
            {stats.CHECKPOINTED}
          </span>
        )}
        {stats.TERMINATED > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
            {stats.TERMINATED}
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      data-testid="agent-card"
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/agents/${agent.id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          navigate(`/agents/${agent.id}`);
        }
      }}
      className={cn(
        'group relative w-full text-left rounded-lg border border-surface-700',
        'bg-gradient-to-b from-surface-800 to-surface-800/60',
        'border-l-2', statusConfig.borderColor,
        'cursor-pointer transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-950'
      )}
    >
      <div className="relative p-5 flex flex-col md:flex-row items-start gap-6 min-h-[120px]">
        <AgentAvatar harnessType={agent.harness} className="hidden md:block" />

        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <StatusPulse
              status={statusConfig.pulseStatus}
              width={12}
              height={12}
              className="flex-shrink-0"
            />
            <h3
              data-testid="agent-name"
              className="text-lg font-semibold text-surface-100 truncate"
              title={agent.name}
            >
              {agent.name}
            </h3>
            <span
              data-testid="agent-status-label"
              className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-surface-600/50 bg-surface-700/40 px-2 py-0.5 text-[11px] font-medium text-surface-300"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', statusConfig.dotColor)} />
              {statusLabel}
            </span>
          </div>
          <div className="h-10">
            <p className="text-sm text-surface-400 line-clamp-2">
              {agent.description || <span className="italic text-surface-500">No description provided.</span>}
            </p>
          </div>
          <p className="text-[11px] text-surface-500 mt-0.5">
            Created {formatRelativeTime(agent.createdAt)}
          </p>
        </div>

        <div className="flex flex-wrap md:flex-nowrap items-center gap-6 text-sm text-surface-300 md:px-6 md:border-x md:border-surface-700/50">
          <div className="flex flex-col min-w-[70px]">
            <span className="text-[10px] text-surface-500 uppercase tracking-wider font-medium mb-0.5">Sessions</span>
            {renderSessions()}
          </div>
          <div className="flex flex-col min-w-[70px]">
            <span className="text-[10px] text-surface-500 uppercase tracking-wider font-medium mb-0.5">Tools</span>
            <AnimatedCounter value={totalTools} className="tabular-nums font-medium text-surface-200" />
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-3 flex-shrink-0 min-w-[200px]">
          <div className="flex items-center gap-2">
            {agent.harness && (
              <span className="rounded bg-surface-700/60 px-1.5 py-0.5 text-[10px] font-medium text-surface-300 uppercase tracking-wider">
                {agent.harness}
              </span>
            )}
            <span className="font-mono text-xs text-surface-400">
              {(agent.harnessConfig as Record<string, unknown>)?.model as string ?? agent.harness}
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {agent.hasPendingInterrupt && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 border border-orange-500/30 px-2 py-0.5 text-[11px] font-medium text-orange-400">
                <AlertCircle className="h-3 w-3" />
                Approval Needed
              </span>
            )}
            {activeSessionCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                <Activity className="h-3 w-3" />
                {activeSessionCount} Active
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[11px] text-surface-400">
              <Clock className="h-3 w-3" />
              {formatRelativeTime(agent.lastActivity)}
            </span>
          </div>

          <div className="flex items-center gap-2 mt-1 w-full md:w-auto">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); navigate(agentLegacyNewSessionPath(agent.id)); }}
              aria-label={`Open session for ${agent.name}`}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 rounded-md bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 transition-colors shadow-sm focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              New Session
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEdit?.(agent); }}
              aria-label={`Edit ${agent.name}`}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 rounded-md bg-surface-700 px-3 py-1.5 text-xs font-medium text-surface-100 hover:bg-surface-600 transition-colors shadow-sm focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}`); }}
              aria-label={`View details for ${agent.name}`}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 rounded-md bg-surface-700 px-4 py-1.5 text-xs font-medium text-surface-100 hover:bg-surface-600 transition-colors shadow-sm focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
            >
              <Settings className="h-3.5 w-3.5" />
              Details
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
