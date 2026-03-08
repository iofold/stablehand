import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cpu,
  Bot,
  Wrench,
  Activity,
  Radio,
  Users,
  X,
} from 'lucide-react';
import { useAgentsStore } from '@/stores/agents';
import type { AgentRun } from '@/stores/agents';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { fetchAllActiveRuns } from '@/lib/api';

export function DashboardPage() {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const startPolling = useAgentsStore((s) => s.startPolling);
  const cancelRun = useAgentsStore((s) => s.cancelRun);

  const navigate = useNavigate();
  const [activeRuns, setActiveRuns] = useState<AgentRun[]>([]);

  useEffect(() => {
    fetchAgents();
    const stop = startPolling();
    return stop;
  }, [fetchAgents, startPolling]);

  // Poll active runs
  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const runs = await fetchAllActiveRuns();
        if (mounted) setActiveRuns(Array.isArray(runs) ? runs : []);
      } catch {
        // ignore — endpoint may not be available yet
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

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
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-surface-700/50 bg-surface-900/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <Cpu className="h-5 w-5 text-brand-400" />
            <h1 className="text-lg font-bold tracking-tight text-surface-100">
              CTXMill
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            <span className="text-xs text-surface-400">System Online</span>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        {/* Hero section with gradient accent */}
        <div className="relative mb-8 overflow-hidden rounded-2xl border border-surface-700/40 bg-gradient-to-br from-surface-800/90 via-surface-800/70 to-surface-900/90 p-6 sm:p-8">
          {/* Decorative gradient orb */}
          <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-brand-500/[0.07] blur-3xl" />
          <div className="pointer-events-none absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-brand-400/[0.05] blur-2xl" />

          <div className="relative">
            <h2 className="text-2xl font-semibold tracking-tight text-surface-50">
              Agent Dashboard
            </h2>
            <p className="mt-1.5 text-sm text-surface-400 max-w-lg">
              Monitor, manage, and interact with your agentic workflows. Each
              agent runs in an isolated sandbox with its own tools and knowledge.
            </p>
          </div>

          {/* Stats row */}
          <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              icon={<Bot className="h-4 w-4" />}
              label="Total Agents"
              value={loading ? '--' : String(agents.length)}
              accent="text-brand-400"
            />
            <StatTile
              icon={<Activity className="h-4 w-4" />}
              label="Active"
              value={loading ? '--' : String(stats.activeAgents)}
              accent="text-green-400"
            />
            <StatTile
              icon={<Wrench className="h-4 w-4" />}
              label="Tools Loaded"
              value={loading ? '--' : String(stats.totalTools)}
              accent="text-amber-400"
            />
            <StatTile
              icon={<Users className="h-4 w-4" />}
              label="Connections"
              value={loading ? '--' : String(stats.totalConnections)}
              accent="text-purple-400"
            />
          </div>
        </div>

        {/* SSE status bar */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-surface-300">Agents</h3>
            {!loading && (
              <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[11px] font-medium text-surface-400 border border-surface-700/50">
                {agents.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-surface-500">
            <Radio className="h-3 w-3 text-green-400 animate-pulse-slow" />
            <span>SSE Connected</span>
          </div>
        </div>

        <Dashboard agents={agents} loading={loading} />

        {/* Active Runs Section */}
        {activeRuns.length > 0 && (
          <div data-testid="active-runs-section" className="mt-8 animate-fade-in">
            <div className="mb-4 flex items-center gap-2">
              <h3 className="text-sm font-medium text-surface-300">Active Runs</h3>
              <span className="rounded-full bg-green-500/15 border border-green-500/30 px-2 py-0.5 text-[10px] font-medium text-green-300">
                {activeRuns.length}
              </span>
            </div>
            <div className="space-y-2">
              {activeRuns.map((run) => (
                <div
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
                  className="flex items-center gap-3 rounded-lg border border-surface-700/40 bg-surface-800/60 px-4 py-3 text-sm cursor-pointer hover:border-brand-500/40 hover:bg-surface-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <RunStatusBadge status={run.status} />
                  <span className="font-medium text-surface-200 min-w-0 truncate">
                    {agentNameMap[run.agentId] || run.agentId}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-surface-400 text-xs">
                    {run.taskDescription || '--'}
                  </span>
                  <span className="flex-shrink-0 text-[11px] text-surface-500 tabular-nums">
                    {formatDuration(run.startedAt)}
                  </span>
                  <button
                    type="button"
                    data-testid="cancel-run-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCancelRun(run);
                    }}
                    className="flex-shrink-0 rounded-md p-1 text-surface-500 transition-colors hover:text-red-400 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    title="Cancel run"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-surface-700/30 bg-surface-900/60 px-4 py-3">
      <div className={`flex-shrink-0 ${accent}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-lg font-semibold tabular-nums text-surface-100 leading-tight">
          {value}
        </p>
        <p className="text-[11px] text-surface-500 leading-tight mt-0.5">
          {label}
        </p>
      </div>
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
