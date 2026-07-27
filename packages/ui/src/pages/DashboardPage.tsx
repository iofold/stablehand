import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { StatusBadge } from '@/components/dashboard/StatusBadge';
import { fetchActiveConversations, fetchConversationSummaries } from '@/lib/api';
import { useApiAuthStore } from '@/lib/auth';
import {
  countActiveSandboxSessions,
  isTerminalConversationStatus,
} from '@/lib/lifecycle-status';
import type { ConversationSummary } from '@ctxmill/contracts';
import { PageShell } from '@/components/ui/PageShell';
import { StatsRow } from '@/components/ui/StatsRow';
import { formatCompactNumber, formatDurationBetween, formatRunningDuration } from '@/lib/format';
import { describeConversationCostRollup } from '@/lib/usage-cost';

export function DashboardPage() {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const cancelTurn = useAgentsStore((s) => s.cancelTurn);
  const agentLoadError = useAgentsStore((s) => s.error);
  const authRequired = useApiAuthStore((s) => s.authRequired);
  const displayLoading = authRequired || loading;

  const navigate = useNavigate();
  const [activeConversations, setActiveConversations] = useState<ConversationSummary[]>([]);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      if (useApiAuthStore.getState().authRequired) return;

      try {
        await fetchAgents();
      } catch (err) {
        console.debug('[Dashboard] Agent fetch failed:', err);
      }
      if (useApiAuthStore.getState().authRequired) return;

      try {
        const activeConversations = await fetchActiveConversations();
        
        const currentAgents = useAgentsStore.getState().agents;
        const agentConvPromises = currentAgents
          .filter(a => (a.conversationCount ?? 0) > 0)
          .map(a => fetchConversationSummaries(a.id).then(d => {
            return d.conversations;
          }).catch(() => []));
        const allAgentConvs = (await Promise.all(agentConvPromises)).flat();

        const merged = new Map<string, ConversationSummary>();
        for (const c of [...activeConversations, ...allAgentConvs]) merged.set(c.id, c);
        const allConvs = Array.from(merged.values())
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 20);
          
        if (mounted) setActiveConversations(allConvs);
      } catch (err) {
        console.debug('[Dashboard] Active conversations poll failed:', err);
      }
    }

    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [fetchAgents, authRequired]);

  const stats = useMemo(() => {
    const totalTools = agents.reduce((sum, a) => sum + a.tools.length, 0);
    const activeAgents = agents.filter(
      (a) => countActiveSandboxSessions(a.sandboxSessionsByStatus) > 0 || a.status === 'running',
    ).length;
    return { totalTools, activeAgents };
  }, [agents]);

  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [agents]);

  const handleCancelRun = async (conv: ConversationSummary) => {
    setCancelError(null);
    try {
      if (conv.latestTurnId) {
        await cancelTurn(conv.agentId, conv.latestTurnId);
      }
      setActiveConversations((prev) => prev.filter((entry) => entry.id !== conv.id));
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      {/* Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-8">
        <div>
          <PageShell title="Agent Dashboard" description="Manage your agentic workflows." />
          <StatsRow
            prominent
            items={[
              { label: 'Total Agents', value: displayLoading ? '--' : agents.length },
              { label: 'Active', value: displayLoading ? '--' : stats.activeAgents },
              { label: 'Tools Loaded', value: displayLoading ? '--' : stats.totalTools },
            ]}
          />
        </div>

        <div>
          <div className="mb-4 flex items-center gap-2">
            <h3 className="text-label">
              Agents {!displayLoading && (filteredCount !== null && filteredCount !== agents.length ? `(${filteredCount} of ${agents.length})` : `(${agents.length})`)}
            </h3>
          </div>

          <Dashboard
            agents={agents}
            loading={displayLoading}
            error={authRequired ? null : agentLoadError}
            onFilteredCountChange={setFilteredCount}
            onRetry={() => { void fetchAgents(); }}
          />
        </div>

        {cancelError && (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            Failed to cancel conversation: {cancelError}
          </div>
        )}

        {activeConversations.length > 0 && (
          <div data-testid="active-sessions-section" className="animate-fade-in">
            <div className="mb-4 flex items-center gap-2">
              <h3 className="text-sm font-medium text-surface-400">Recent Conversations</h3>
              <span className="rounded-full bg-surface-500/15 border border-surface-500/30 px-2 py-0.5 text-[10px] font-medium text-surface-300">
                {activeConversations.length}
              </span>
            </div>
            <div className="border border-surface-700 rounded-lg overflow-x-auto bg-surface-800/30">
              <table className="w-full text-left border-collapse min-w-[600px]">
                <thead>
                  <tr className="bg-surface-800/50">
                    <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Agent Name</th>
                    <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Status</th>
                    <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Task Description</th>
                    <th className="px-4 py-3 text-label border-b border-surface-700 font-medium text-right">Usage</th>
                    <th className="px-4 py-3 text-label border-b border-surface-700 font-medium text-right">Duration</th>
                    <th className="px-4 py-3 border-b border-surface-700"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-700/50">
                  {activeConversations.map((conv) => {
                    const terminal = isTerminalConversationStatus(conv.status);
                    return (
                      <tr
                        key={conv.id}
                        onClick={() => navigate(`/agents/${conv.agentId}/conversations/${conv.id}`)}
                        className="hover:bg-surface-800/50 cursor-pointer transition-colors focus-visible:bg-surface-800/50 group"
                      >
                        <td className="px-4 py-3 text-sm font-medium text-surface-200">
                          {agentNameMap[conv.agentId] || conv.agentId}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={conv.status} subject="Conversation" />
                        </td>
                        <td className="px-4 py-3 text-sm text-surface-400">
                          <div className="max-w-[200px] sm:max-w-xs md:max-w-md truncate">
                            {conv.taskDescription || '--'}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-surface-400 tabular-nums text-right">
                          {conv.totalTokens !== null
                            ? `${formatCompactNumber(conv.totalTokens)} tok`
                            : '—'}
                          {(() => {
                            const cost = describeConversationCostRollup(conv);
                            return cost
                              ? <span className="ml-2" title={cost.title}>{cost.label}</span>
                              : null;
                          })()}
                        </td>
                        <td
                          data-testid="conversation-duration"
                          className="px-4 py-3 text-sm text-surface-400 tabular-nums text-right"
                        >
                          {terminal
                            ? formatDurationBetween(conv.startedAt, conv.completedAt ?? conv.updatedAt)
                            : formatRunningDuration(conv.startedAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!terminal && (
                            <button
                              type="button"
                              data-testid="cancel-run-button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleCancelRun(conv);
                              }}
                              className="rounded-md p-1.5 text-surface-400 transition-colors hover:text-red-400 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                              title="Cancel conversation"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
