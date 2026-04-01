import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { fetchActiveConversations, fetchConversationSummaries } from '@/lib/api';

export interface ApiConversationSummary {
  id: string;
  agentId: string;
  status: 'running' | 'paused' | 'suspended' | 'completed' | 'error' | 'idle';
  mode: 'interactive' | 'background';
  turnCount: number;
  messageCount: number;
  taskDescription?: string;
  startedAt: number;
  updatedAt: number;
  latestTurnId?: string;
  sandboxSessionId?: string;
  sandboxStatus?: string;
}

export function DashboardPage() {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const cancelRun = useAgentsStore((s) => s.cancelRun);

  const navigate = useNavigate();
  const [activeConversations, setActiveConversations] = useState<ApiConversationSummary[]>([]);
  const [filteredCount, setFilteredCount] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        await fetchAgents();
      } catch (err) {
        console.debug('[Dashboard] Agent fetch failed:', err);
      }
      try {
        const activeConvs = await fetchActiveConversations();
        const activeArray = Array.isArray(activeConvs) ? activeConvs : [];
        
        const currentAgents = useAgentsStore.getState().agents;
        const agentConvPromises = currentAgents
          .filter(a => (a.conversationCount ?? 0) > 0 || (a.totalSessions ?? 0) > 0)
          .map(a => fetchConversationSummaries(a.id).then(d => {
            const convs = (d as { conversations?: ApiConversationSummary[] })?.conversations || d;
            return Array.isArray(convs) ? convs : [];
          }).catch(() => []));
        const allAgentConvs = (await Promise.all(agentConvPromises)).flat();

        const merged = new Map<string, ApiConversationSummary>();
        for (const c of [...activeArray, ...allAgentConvs]) merged.set(c.id, c);
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
  }, [fetchAgents]);

  const stats = useMemo(() => {
    const totalTools = agents.reduce((sum, a) => sum + a.tools.length, 0);
    const activeAgents = agents.filter(
      (a) => ((a.sessionsByStatus?.active ?? 0) + (a.sessionsByStatus?.paused ?? 0)) > 0 || a.status === 'running' || a.status === 'booting',
    ).length;
    return { totalTools, activeAgents };
  }, [agents]);

  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [agents]);

  const handleCancelRun = async (conv: ApiConversationSummary) => {
    if (conv.sandboxSessionId) {
      await cancelRun(conv.agentId, conv.sandboxSessionId);
    }
    setActiveConversations((prev) => prev.filter((entry) => entry.id !== conv.id));
  };

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      {/* Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-8">
        {/* Hero section */}
        <div>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-surface-200">
              Agent Dashboard
            </h2>
            <p className="mt-1.5 text-sm text-surface-400 max-w-lg">
              Manage your agentic workflows.
            </p>
          </div>

          {/* Stats row */}
          <div className="mt-6 flex flex-col sm:flex-row items-stretch divide-y sm:divide-y-0 sm:divide-x divide-surface-700">
            <div className="flex-1 p-4 first:pl-0">
              <p className="text-label">Total Agents</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-surface-100">
                {loading ? '--' : agents.length}
              </p>
            </div>
            <div className="flex-1 p-4">
              <p className="text-label">Active</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-surface-100">
                {loading ? '--' : stats.activeAgents}
              </p>
            </div>
            <div className="flex-1 p-4">
              <p className="text-label">Tools Loaded</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-surface-100">
                {loading ? '--' : stats.totalTools}
              </p>
            </div>

          </div>
        </div>

        <div>
          <div className="mb-4 flex items-center gap-2">
            <h3 className="text-label">
              Agents {!loading && (filteredCount !== null && filteredCount !== agents.length ? `(${filteredCount} of ${agents.length})` : `(${agents.length})`)}
            </h3>
          </div>

          <Dashboard agents={agents} loading={loading} onFilteredCountChange={setFilteredCount} />
        </div>

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
                    <th className="px-4 py-3 text-label border-b border-surface-700 font-medium text-right">Duration</th>
                    <th className="px-4 py-3 border-b border-surface-700"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-700/50">
                  {activeConversations.map((conv) => (
                    <tr
                      key={conv.id}
                      onClick={() => navigate(`/agents/${conv.agentId}/conversations/${conv.id}`)}
                      className="hover:bg-surface-800/50 cursor-pointer transition-colors focus-visible:bg-surface-800/50 group"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-surface-200">
                        {agentNameMap[conv.agentId] || conv.agentId}
                      </td>
                      <td className="px-4 py-3">
                        <RunStatusBadge status={conv.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400">
                        <div className="max-w-[200px] sm:max-w-xs md:max-w-md truncate">
                          {conv.taskDescription || '--'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums text-right">
                        {formatDuration(conv.startedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          data-testid="cancel-run-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelRun(conv);
                          }}
                          className="rounded-md p-1.5 text-surface-400 transition-colors hover:text-red-400 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                          title="Cancel conversation"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}



function formatDuration(startedAt: number): string {
  const elapsed = Math.max(0, Date.now() - startedAt);
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
