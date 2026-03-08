import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  Cpu,
  Clock,
  Loader2,
} from 'lucide-react';
import { ChatThread } from '@/components/chat/ChatThread';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { useAgentsStore } from '@/stores/agents';
import type { AgentRun } from '@/stores/agents';
import type { Message } from '@/stores/conversation';
import { fetchRuns, fetchMessages } from '@/lib/api';

export function RunDetailPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const navigate = useNavigate();
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const [run, setRun] = useState<AgentRun | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    if (!id || !runId) return;
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const runs = await fetchRuns(id!);
        const allRuns = Array.isArray(runs) ? runs : [];
        const found = allRuns.find((r: AgentRun) => r.id === runId);
        if (!found) {
          if (mounted) setError('Run not found');
          return;
        }
        if (mounted) setRun(found);

        if (found.conversationId) {
          const msgs = await fetchMessages(id!, found.conversationId);
          if (mounted) {
            setMessages(
              Array.isArray(msgs)
                ? msgs.map((m: Record<string, unknown>, i: number) => ({
                    id: (m.id as string) || `msg-${i}`,
                    role: (m.role as Message['role']) || 'assistant',
                    content: (m.content as string) || '',
                    toolCalls: m.toolCalls as Message['toolCalls'],
                    a2uiBlocks: m.a2uiBlocks as Message['a2uiBlocks'],
                    createdAt: (m.createdAt as string) || new Date().toISOString(),
                  }))
                : [],
            );
          }
        }
      } catch (err) {
        if (mounted) setError(String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [id, runId]);

  const agent = agents.find((a) => a.id === id);

  const duration = run
    ? formatDuration(run.startedAt, run.completedAt)
    : '';

  return (
    <div
      data-testid="run-detail-page"
      className="flex h-screen flex-col bg-surface-950"
    >
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-surface-700/40 bg-surface-900/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
          {/* Back */}
          <button
            type="button"
            data-testid="back-button"
            onClick={() => navigate('/')}
            className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-surface-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          {/* Agent identity */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600/20 ring-1 ring-brand-500/30">
              <Bot className="h-4 w-4 text-brand-400" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-surface-100 leading-tight">
                {agent?.name ?? 'Agent'}
              </h1>
              {agent && (
                <div className="flex items-center gap-1.5 text-[11px] text-surface-500 leading-tight">
                  <Cpu className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate font-mono">{agent.model}</span>
                </div>
              )}
            </div>
          </div>

          {/* Run info */}
          {run && (
            <div className="ml-auto flex items-center gap-3">
              <RunStatusBadge status={run.status} />
              {duration && (
                <span className="flex items-center gap-1 text-[11px] text-surface-400">
                  <Clock className="h-3 w-3" />
                  {duration}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Task description bar */}
        {run?.taskDescription && (
          <div className="border-t border-surface-700/30 bg-surface-800/40">
            <div className="mx-auto max-w-5xl px-4 sm:px-6 py-2">
              <p className="text-xs text-surface-400">
                <span className="font-medium text-surface-300">Task:</span>{' '}
                {run.taskDescription}
              </p>
            </div>
          </div>
        )}
      </header>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 text-brand-400 animate-spin" />
          </div>
        )}

        {error && (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <div data-testid="run-messages" className="flex-1 overflow-hidden">
            <ChatThread
              messages={messages}
              streamingContent=""
              isStreaming={false}
              agentName={agent?.name}
              agentTools={agent?.tools}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(startedAt: number, completedAt?: number): string {
  const end = completedAt || Date.now();
  const elapsed = Math.max(0, end - startedAt);
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
