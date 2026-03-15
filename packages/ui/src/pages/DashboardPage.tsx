import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import type { AgentRun } from '@/stores/agents';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { fetchAllActiveRuns } from '@/lib/api';

export function DashboardPage() {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const cancelRun = useAgentsStore((s) => s.cancelRun);

  const navigate = useNavigate();
  const [activeRuns, setActiveRuns] = useState<AgentRun[]>([]);

  // Single consolidated polling interval for both agents and active runs
  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        await fetchAgents();
      } catch (err) {
        console.debug('[Dashboard] Agent fetch failed:', err);
      }
      try {
        const runs = await fetchAllActiveRuns();
        if (mounted) setActiveRuns(Array.isArray(runs) ? runs : []);
      } catch (err) {
        console.debug('[Dashboard] Active runs poll failed:', err);
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
      (a) => (a.activeRuns ?? 0) > 0 || a.status === 'running' || a.status === 'booting',
    ).length;
    const totalConnections = agents.reduce((sum, a) => sum + (a.sseClients ?? 0), 0);
    return { totalTools, activeAgents, totalConnections };
  }, [agents]);

  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [agents]);

  const handleCancelRun = async (run: AgentRun) => {
    await cancelRun(run.agentId, run.id);
    setActiveRuns((prev) => prev.filter((r) => r.id !== run.id));
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
            <div className="flex-1 p-4">
              <p className="text-label">Connections</p>
              <p className="mt-1 text-3xl font-bold tabular-nums text-surface-100">
                {loading ? '--' : stats.totalConnections}
              </p>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-4 flex items-center gap-2">
            <h3 className="text-label">Agents {!loading && `(${agents.length})`}</h3>
          </div>

          <Dashboard agents={agents} loading={loading} />
        </div>

        {/* Active Runs Section */}
        {activeRuns.length > 0 && (
          <div data-testid="active-runs-section" className="animate-fade-in">
            <div className="mb-4 flex items-center gap-2">
              <h3 className="text-sm font-medium text-surface-400">Active Runs</h3>
              <span className="rounded-full bg-green-500/15 border border-green-500/30 px-2 py-0.5 text-[10px] font-medium text-green-300">
                {activeRuns.length}
              </span>
            </div>
            <div className="border border-surface-700 rounded-lg overflow-hidden bg-surface-800/30">
              <table className="w-full text-left border-collapse">
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
                  {activeRuns.map((run) => (
                    <tr
                      key={run.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/agents/${run.agentId}/runs/${run.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(`/agents/${run.agentId}/runs/${run.id}`);
                        }
                      }}
                      className="hover:bg-surface-800/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-surface-800/50 group"
                    >
                      <td className="px-4 py-3 text-sm font-medium text-surface-200">
                        {agentNameMap[run.agentId] || run.agentId}
                      </td>
                      <td className="px-4 py-3">
                        <RunStatusBadge status={run.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400">
                        <div className="max-w-[200px] sm:max-w-xs md:max-w-md truncate">
                          {run.taskDescription || '--'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums text-right">
                        {formatDuration(run.startedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          data-testid="cancel-run-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelRun(run);
                          }}
                          className="rounded-md p-1.5 text-surface-500 transition-colors hover:text-red-400 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                          title="Cancel run"
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
