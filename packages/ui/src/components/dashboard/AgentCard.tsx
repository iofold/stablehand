import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Wrench, ChevronRight, Zap, Users, MessageSquare, Play } from 'lucide-react';
import { AgentStatusBadge } from './AgentStatusBadge';
import { RunStatusBadge } from './RunStatusBadge';
import { useAgentsStore } from '@/stores/agents';
import type { Agent } from '@/stores/agents';
import { cn } from '@/lib/utils';

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  const navigate = useNavigate();
  const startBackgroundRun = useAgentsStore((s) => s.startBackgroundRun);
  const isActive = agent.status === 'running' || agent.status === 'booting';
  const [showRunForm, setShowRunForm] = useState(false);
  const [task, setTask] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleStartRun = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!task.trim()) return;
    setSubmitting(true);
    try {
      await startBackgroundRun(agent.id, task.trim());
      setTask('');
      setShowRunForm(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-testid="agent-card"
        onClick={() => navigate(`/agents/${agent.id}/chat`)}
        className="card group relative w-full overflow-hidden text-left p-5 transition-all duration-200 hover:border-brand-500/40 hover:shadow-brand-500/5 hover:shadow-xl hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {/* Top gradient accent line */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-500/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

        {/* Subtle corner glow on hover */}
        <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-brand-500/[0.08] blur-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

        <div className="relative flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative flex-shrink-0 rounded-lg bg-brand-600/10 p-2.5 border border-brand-600/20 transition-colors group-hover:bg-brand-600/20 group-hover:border-brand-500/30">
              <Bot className="h-5 w-5 text-brand-400" />
              {/* Activity pulse dot */}
              {isActive && (
                <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-30" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-400 border border-surface-800" />
                </span>
              )}
            </div>
            <div className="min-w-0">
              <h3
                data-testid="agent-name"
                className="font-semibold text-surface-100 truncate group-hover:text-brand-300 transition-colors"
              >
                {agent.name}
              </h3>
              <p className="text-xs text-surface-500 font-mono mt-0.5">{agent.model}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 mt-1">
            {/* Active runs indicator */}
            {(agent.activeRuns ?? 0) > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-green-500/15 border border-green-500/30 px-2 py-0.5 text-[10px] font-medium text-green-300">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-40" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-400" />
                </span>
                {agent.activeRuns} running
              </span>
            )}
            <ChevronRight className="h-4 w-4 text-surface-600 group-hover:text-brand-400 group-hover:translate-x-0.5 transition-all duration-200" />
          </div>
        </div>

        {agent.description && (
          <p className="relative mt-3 text-sm text-surface-400 line-clamp-2">{agent.description}</p>
        )}

        {/* Tool pills */}
        {agent.tools.length > 0 && (
          <div className="relative mt-3 flex flex-wrap gap-1.5">
            {agent.tools.slice(0, 4).map((tool) => (
              <span
                key={tool}
                className="inline-flex items-center gap-1 rounded-md bg-surface-700/50 border border-surface-600/30 px-2 py-0.5 text-[10px] font-medium text-surface-400 transition-colors group-hover:border-surface-600/50 group-hover:text-surface-300"
              >
                <Wrench className="h-2.5 w-2.5" />
                {tool}
              </span>
            ))}
            {agent.tools.length > 4 && (
              <span className="inline-flex items-center rounded-md bg-surface-700/30 px-2 py-0.5 text-[10px] font-medium text-surface-500">
                +{agent.tools.length - 4} more
              </span>
            )}
          </div>
        )}

        {/* Recent run pills */}
        {agent.runs && agent.runs.length > 0 && (
          <div className="relative mt-3 flex flex-wrap gap-1.5">
            {agent.runs.slice(0, 3).map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/agents/${agent.id}/runs/${run.id}`);
                }}
                className="inline-flex items-center gap-1 rounded-md bg-surface-700/30 border border-surface-600/20 px-2 py-0.5 text-[10px] text-surface-400 hover:bg-surface-600/40 hover:border-surface-500/40 hover:text-surface-300 transition-colors cursor-pointer"
                title={run.taskDescription || run.id}
              >
                <RunStatusBadge status={run.status} className="border-0 px-0 py-0" />
                <span className="max-w-[80px] truncate">{run.taskDescription || 'run'}</span>
                <span className="text-surface-600">{formatRelativeTime(run.startedAt)}</span>
              </button>
            ))}
          </div>
        )}

        {/* Live session metrics */}
        {(agent.sseClients !== undefined && agent.sseClients > 0) || (agent.conversationCount !== undefined && agent.conversationCount > 0) ? (
          <div className="relative mt-3 flex items-center gap-3 text-[11px] text-surface-400">
            {agent.sseClients !== undefined && agent.sseClients > 0 && (
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3 text-green-400" />
                {agent.sseClients} connected
              </span>
            )}
            {agent.conversationCount !== undefined && agent.conversationCount > 0 && (
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3 text-brand-400" />
                {agent.conversationCount} session{agent.conversationCount !== 1 ? 's' : ''}
              </span>
            )}
            {agent.lastActivity !== undefined && agent.lastActivity > 0 && (
              <span className="ml-auto text-surface-500" title={new Date(agent.lastActivity).toLocaleString()}>
                {formatRelativeTime(agent.lastActivity)}
              </span>
            )}
          </div>
        ) : null}

        <div className="relative mt-3 flex items-center justify-between">
          <AgentStatusBadge status={agent.status} />
          <div className="flex items-center gap-1.5 text-xs text-surface-500 group-hover:text-surface-400 transition-colors">
            {isActive && <Zap className="h-3 w-3 text-amber-400" />}
            <Wrench className="h-3 w-3" />
            <span>{agent.tools.length} tools</span>
          </div>
        </div>
      </button>

      {/* Start run button */}
      <div className="mt-1.5 flex justify-end px-1">
        <button
          type="button"
          data-testid="start-run-button"
          onClick={(e) => {
            e.stopPropagation();
            setShowRunForm((v) => !v);
          }}
          className={cn(
            'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
            'text-surface-500 hover:text-brand-400 hover:bg-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            showRunForm && 'text-brand-400 bg-surface-800',
          )}
        >
          <Play className="h-3 w-3" />
          Run
        </button>
      </div>

      {/* Inline run form */}
      {showRunForm && (
        <form
          onSubmit={handleStartRun}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 flex items-center gap-2 rounded-lg border border-surface-700/50 bg-surface-800/80 p-2"
        >
          <input
            data-testid="run-task-input"
            type="text"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Describe the task..."
            autoFocus
            className="flex-1 rounded-md border border-surface-600/40 bg-surface-900/60 px-2.5 py-1.5 text-xs text-surface-200 placeholder-surface-600 focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30"
          />
          <button
            type="submit"
            disabled={submitting || !task.trim()}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {submitting ? 'Starting...' : 'Run'}
          </button>
        </form>
      )}
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}
