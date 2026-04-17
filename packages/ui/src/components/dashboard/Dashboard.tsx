import { useState, useMemo, useEffect } from 'react';
import { Plus, Search } from 'lucide-react';
import { AgentCard } from './AgentCard';
import { AgentFormModal } from '@/components/agents/AgentFormModal';
import { cn } from '@/lib/utils';
import type { Agent } from '@/stores/agents';
import { EmptyDashboard } from './illustrations/EmptyDashboard';
import { HoverGlow } from './MicroInteractions';

interface DashboardProps {
  agents: Agent[];
  loading: boolean;
  onFilteredCountChange?: (count: number) => void;
}

type FilterStatus = 'all' | 'running' | 'error' | 'idle';

function SkeletonCard() {
  return (
    <div className="w-full rounded-lg border border-surface-700 bg-surface-800/50 p-5 flex flex-col md:flex-row items-start md:items-center gap-6 min-h-[120px] animate-pulse">
      <div className="flex-1 min-w-0 flex flex-col gap-2 w-full">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full bg-surface-700 flex-shrink-0" />
          <div className="h-5 w-48 rounded bg-surface-700" />
        </div>
        <div className="space-y-1.5 mt-1">
          <div className="h-3.5 w-full max-w-md rounded bg-surface-700/60" />
          <div className="h-3.5 w-3/4 max-w-sm rounded bg-surface-700/60" />
        </div>
        <div className="h-3 w-24 rounded bg-surface-700/40 mt-1" />
      </div>

      <div className="flex items-center gap-6 md:px-6 md:border-x md:border-surface-700/50">
        <div className="space-y-1.5">
          <div className="h-2.5 w-12 rounded bg-surface-700/40" />
          <div className="h-4 w-8 rounded bg-surface-700" />
        </div>
        <div className="space-y-1.5">
          <div className="h-2.5 w-10 rounded bg-surface-700/40" />
          <div className="h-4 w-16 rounded bg-surface-700" />
        </div>
        <div className="space-y-1.5">
          <div className="h-2.5 w-10 rounded bg-surface-700/40" />
          <div className="h-4 w-8 rounded bg-surface-700" />
        </div>
        <div className="space-y-1.5">
          <div className="h-2.5 w-16 rounded bg-surface-700/40" />
          <div className="h-4 w-8 rounded bg-surface-700" />
        </div>
      </div>

      <div className="flex flex-col items-start md:items-end gap-3 flex-shrink-0 min-w-[200px]">
        <div className="flex items-center gap-2">
          <div className="h-4 w-16 rounded bg-surface-700/60" />
          <div className="h-4 w-24 rounded bg-surface-700/40" />
        </div>
        <div className="h-4 w-20 rounded bg-surface-700/40" />
        <div className="flex items-center gap-2 mt-1 w-full md:w-auto">
          <div className="h-8 w-20 rounded-md bg-surface-700" />
          <div className="h-8 w-24 rounded-md bg-surface-700" />
        </div>
      </div>
    </div>
  );
}

export function Dashboard({ agents, loading, onFilteredCountChange }: DashboardProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');

  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      const matchesSearch = agent.name.toLowerCase().includes(searchQuery.toLowerCase());
      
      let matchesStatus = true;
      const activeOrPaused = (agent.sessionsByStatus?.ACTIVE ?? 0) + (agent.sessionsByStatus?.PAUSED ?? 0) + (agent.sessionsByStatus?.RESTORING ?? 0);
      if (statusFilter === 'running') {
        matchesStatus = agent.status === 'running' || agent.status === 'booting' || activeOrPaused > 0;
      } else if (statusFilter === 'error') {
        matchesStatus = agent.status === 'error';
      } else if (statusFilter === 'idle') {
        matchesStatus = agent.status !== 'running' && agent.status !== 'booting' && activeOrPaused === 0 && agent.status !== 'error';
      }

      return matchesSearch && matchesStatus;
    });
  }, [agents, searchQuery, statusFilter]);

  useEffect(() => {
    onFilteredCountChange?.(filteredAgents.length);
  }, [filteredAgents.length, onFilteredCountChange]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3 animate-fade-in">
        {[1, 2, 3].map((id) => (
          <SkeletonCard key={id} />
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
        <div className="rounded-2xl bg-surface-800/50 border border-surface-700/30 p-10 max-w-md">
          <div>
            <div className="mx-auto mb-5">
              <EmptyDashboard className="text-surface-400" />
            </div>
            <h2 className="text-xl font-semibold text-surface-100">No agents yet</h2>
            <p className="mt-2.5 text-sm text-surface-400 leading-relaxed">
              Create your first agent to get started. Agents run in isolated
              sandboxes with tools, knowledge, and chat capabilities.
            </p>
            <button type="button" className="btn-primary mt-6 w-full" onClick={() => setShowCreateModal(true)}>
              <Plus className="h-4 w-4" />
              Create your first agent
            </button>
            <AgentFormModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative max-w-md w-full">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <Search className="h-4 w-4 text-surface-400" />
          </div>
          <input
            type="text"
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full rounded-md border border-surface-700 bg-surface-800/50 py-2 pl-10 pr-3 text-sm text-surface-200 placeholder-surface-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
          />
        </div>
        <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
          {(['all', 'running', 'error', 'idle'] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={cn(
                'whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors border',
                statusFilter === status
                  ? 'bg-surface-700 text-surface-100 border-surface-600'
                  : 'bg-surface-800/50 text-surface-400 border-surface-700/50 hover:bg-surface-800 hover:text-surface-300'
              )}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {filteredAgents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed border-surface-700 rounded-lg bg-surface-800/20">
          <p className="text-surface-400">No agents match your filters.</p>
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              setStatusFilter('all');
            }}
            className="mt-2 text-sm text-accent-400 hover:text-accent-300"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filteredAgents.map((agent, i) => (
            <div
              key={agent.id}
              className="animate-slide-up"
              style={{ animationDelay: `${i * 50}ms`, animationFillMode: 'both' }}
            >
              <HoverGlow>
                <AgentCard agent={agent} onEdit={setEditingAgent} />
              </HoverGlow>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="group flex items-center justify-center gap-4 rounded-lg border border-dashed border-surface-700 bg-surface-800/30 p-6 text-center transition-all duration-200 hover:bg-surface-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 min-h-[120px] w-full"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-800 border border-surface-700 transition-colors">
              <Plus className="h-5 w-5 text-surface-400 transition-colors group-hover:text-surface-300" />
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-surface-400 group-hover:text-surface-300 transition-colors">
                New Agent
              </p>
              <p className="mt-0.5 text-[11px] text-surface-400 group-hover:text-surface-300 transition-colors">
                Add a workflow
              </p>
            </div>
          </button>
        </div>
      )}

      <AgentFormModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
      <AgentFormModal
        open={editingAgent !== null}
        onClose={() => setEditingAgent(null)}
        agent={editingAgent ?? undefined}
      />
    </div>
  );
}
