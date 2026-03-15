import { useState } from 'react';
import { Bot, Plus } from 'lucide-react';
import { AgentCard } from './AgentCard';
import { AgentFormModal } from '@/components/agents/AgentFormModal';
import type { Agent } from '@/stores/agents';

interface DashboardProps {
  agents: Agent[];
  loading: boolean;
}

function SkeletonCard() {
  return (
    <div className="card p-6 animate-pulse">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-surface-700" />
        <div className="space-y-2 flex-1">
          <div className="h-4 w-32 rounded bg-surface-700" />
          <div className="h-3 w-20 rounded bg-surface-700/60" />
        </div>
      </div>
      <div className="mt-3 h-3 w-full rounded bg-surface-700/40" />
      <div className="mt-1.5 h-3 w-2/3 rounded bg-surface-700/40" />
      {/* Skeleton tool pills */}
      <div className="mt-3 flex gap-2">
        <div className="h-5 w-16 rounded-md bg-surface-700/40" />
        <div className="h-5 w-20 rounded-md bg-surface-700/40" />
        <div className="h-5 w-14 rounded-md bg-surface-700/40" />
      </div>
      <div className="mt-4 flex justify-between">
        <div className="h-5 w-16 rounded-full bg-surface-700/60" />
        <div className="h-4 w-12 rounded bg-surface-700/40" />
      </div>
    </div>
  );
}

export function Dashboard({ agents, loading }: DashboardProps) {
  const [showCreateModal, setShowCreateModal] = useState(false);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 animate-fade-in">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
        <div className="rounded-2xl bg-surface-800/50 border border-surface-700/30 p-10 max-w-md">
          <div>
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-800 border border-surface-700/50">
              <Bot className="h-8 w-8 text-accent-400" />
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
    <div className="animate-fade-in">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent, i) => (
          <div
            key={agent.id}
            className="animate-slide-up"
            style={{ animationDelay: `${i * 50}ms`, animationFillMode: 'both' }}
          >
            <AgentCard agent={agent} />
          </div>
        ))}

        {/* "Add agent" ghost card */}
        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="group flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-surface-700 bg-surface-800/30 p-8 text-center transition-all duration-200 hover:bg-surface-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 min-h-[180px]"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-800 border border-surface-700 transition-colors">
            <Plus className="h-5 w-5 text-surface-500 transition-colors group-hover:text-surface-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-surface-400 group-hover:text-surface-300 transition-colors">
              New Agent
            </p>
            <p className="mt-0.5 text-[11px] text-surface-600 group-hover:text-surface-500 transition-colors">
              Add a workflow
            </p>
          </div>
        </button>
      </div>

      <AgentFormModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
    </div>
  );
}
