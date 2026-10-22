import { useNavigate } from 'react-router-dom';
import { MessageSquare, Settings, AlertCircle, Activity, Clock, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAgentStatusConfig } from '@/lib/agent-status';
import { agentNewConversationPath } from '@/lib/routes';
import {
  countActiveSandboxSessions,
  countAllSandboxSessions,
  describeSandboxSessionCounts,
} from '@/lib/lifecycle-status';
import { statusTheme } from '@/lib/status-theme';
import type { Agent } from '@/stores/agents';
import { AgentAvatar } from './illustrations/AgentAvatar';
import { StatusPulse } from './illustrations/StatusPulse';
import { AnimatedCounter } from './MicroInteractions';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { formatCompactNumber } from '@/lib/format';
import type {
  AgentBudgetStatus,
  ModelGatewayStatus,
} from '@stablehand/contracts';
import { harnessLabel } from '@/lib/harness';

interface AgentCardProps {
  agent: Agent;
  onEdit?: (agent: Agent) => void;
  budgetStatus?: AgentBudgetStatus;
  modelGatewayStatus?: ModelGatewayStatus;
}

type DashboardStatus = 'running' | 'idle';

function getDashboardStatus(agent: Agent, activeSessionCount: number): DashboardStatus {
  const status = agent.status.toLowerCase();
  if (status === 'running' || activeSessionCount > 0) return 'running';
  return 'idle';
}

function formatAgentStatusLabel(status: DashboardStatus): string {
  const labels: Record<DashboardStatus, string> = {
    idle: 'Idle',
    running: 'Running',
  };
  return labels[status];
}

export function AgentCard({
  agent,
  onEdit,
  budgetStatus,
  modelGatewayStatus,
}: AgentCardProps) {
  const navigate = useNavigate();

  // Name the policies whose thresholds this agent actually tripped so the
  // chip can say which budget is warning/blocking, not just that one is.
  const trippedPolicyNames = budgetStatus && budgetStatus.state !== 'ok'
    ? [...new Set(
        budgetStatus.matches
          .filter((match) => match.statuses.some((status) => status.state !== 'ok'))
          .map((match) => match.policyName),
      )]
    : [];

  const activeSessionCount = countActiveSandboxSessions(agent.sandboxSessionsByStatus);
  const dashboardStatus = getDashboardStatus(agent, activeSessionCount);
  const statusConfig = getAgentStatusConfig(dashboardStatus);
  const statusLabel = formatAgentStatusLabel(dashboardStatus);

  // Native policy names are filters, not additional declared tools. Counting
  // denied names as capabilities made this number actively misleading.
  const totalTools = agent.tools.length;

  const renderSessions = () => {
    const stats = agent.sandboxSessionsByStatus;
    const total = countAllSandboxSessions(stats);
    if (!stats || total === 0) {
      return <span className="tabular-nums font-medium text-surface-200">0</span>;
    }

    // Live vocabulary only: running (active + restoring) and resumable
    // (checkpointed). Ended sandboxes are history — tooltip, not dots.
    const running = (stats.ACTIVE ?? 0) + (stats.RESTORING ?? 0);
    const resumable = stats.CHECKPOINTED ?? 0;
    const title = describeSandboxSessionCounts(stats);

    if (running === 0 && resumable === 0) {
      return (
        <span
          role="status"
          aria-label={`${total} sandbox sessions: ${title}`}
          title={title}
          className="tabular-nums font-medium text-surface-400"
        >
          0
        </span>
      );
    }

    return (
      <div role="status" aria-label={`${total} sandbox sessions: ${title}`} className="flex items-center gap-2.5 tabular-nums font-medium text-surface-200" title={title}>
        {running > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className={cn('w-1.5 h-1.5 rounded-full', statusTheme('ACTIVE').dot)}></span>
            {running}
            <span className="text-[10px] font-normal text-surface-400">running</span>
          </span>
        )}
        {resumable > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className={cn('w-1.5 h-1.5 rounded-full', statusTheme('CHECKPOINTED').dot)}></span>
            {resumable}
            <span className="text-[10px] font-normal text-surface-400">resumable</span>
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
              {agent.description || <span className="italic text-surface-500">No description</span>}
            </p>
          </div>
          <p className="text-[11px] text-surface-500 mt-0.5">
            Created <RelativeTime timestamp={agent.createdAt} />
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
          <div className="flex flex-col min-w-[70px]">
            <span className="text-[10px] text-surface-500 uppercase tracking-wider font-medium mb-0.5">Tokens 24h</span>
            <span
              className="tabular-nums font-medium text-surface-200"
              title={`${(agent.tokensTotal ?? 0).toLocaleString()} tokens total`}
            >
              {formatCompactNumber(agent.tokensLast24h ?? 0)}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-start md:items-end gap-3 flex-shrink-0 min-w-[200px]">
          <div className="flex items-center gap-2">
            {agent.harness && (
              <span className="rounded bg-surface-700/60 px-1.5 py-0.5 text-[10px] font-medium text-surface-300 uppercase tracking-wider">
                {harnessLabel(agent.harness)}
              </span>
            )}
            <span className="font-mono text-xs text-surface-400">
              {(agent.harnessConfig as Record<string, unknown>)?.model as string ?? agent.harness}
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {budgetStatus && budgetStatus.state !== 'ok' && (
              <button
                type="button"
                data-testid="agent-budget-chip"
                title={`Budget ${budgetStatus.state}${trippedPolicyNames.length > 0 ? `: ${trippedPolicyNames.join(', ')}` : ''} — view budget policies`}
                onClick={(event) => {
                  event.stopPropagation();
                  navigate('/settings#budgets');
                }}
                className={cn(
                  'inline-flex max-w-[220px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium hover:brightness-125',
                  budgetStatus.state === 'blocked'
                    ? 'border-red-500/30 bg-red-500/15 text-red-300'
                    : 'border-amber-500/30 bg-amber-500/15 text-amber-300',
                )}
              >
                <AlertCircle className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {trippedPolicyNames.length > 0
                    ? `${trippedPolicyNames[0]} ${budgetStatus.state}`
                    : `Budget ${budgetStatus.state}`}
                </span>
              </button>
            )}
            {modelGatewayStatus?.state === 'degraded' && (
              <span
                data-testid="agent-metering-chip"
                title={modelGatewayStatus.lastError ?? 'Model cost reconciliation is delayed.'}
                className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-300"
              >
                <AlertCircle className="h-3 w-3" />
                Cost tracking delayed
              </span>
            )}
            {agent.hasPendingInterrupt && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 border border-orange-500/30 px-2 py-0.5 text-[11px] font-medium text-orange-400">
                <AlertCircle className="h-3 w-3" />
                Approval needed
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
              <RelativeTime timestamp={agent.lastActivity} />
            </span>
          </div>

          <div className="flex items-center gap-2 mt-1 w-full md:w-auto">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); navigate(agentNewConversationPath(agent.id)); }}
              aria-label={`Open conversation for ${agent.name}`}
              className="flex-1 md:flex-none flex items-center justify-center gap-1.5 rounded-md bg-accent-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-500 transition-colors shadow-sm focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              New conversation
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
