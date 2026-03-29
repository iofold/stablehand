import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Bot,
  Cpu,
  Clock,
  Loader2,
} from 'lucide-react';
import { SessionThread } from '@/components/session/SessionThread';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { useAgentsStore } from '@/stores/agents';
import type { AgentSession } from '@/stores/agents';
import { normalizeConversationMessage } from '@/stores/conversation';
import type { Message } from '@/stores/conversation';
import { fetchSessions, fetchMessages } from '@/lib/api';

export function SessionDetailPage() {
  const { id, sessionId } = useParams<{ id: string; sessionId: string }>();
  const navigate = useNavigate();
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const [session, setSession] = useState<AgentSession | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) fetchAgents();
  }, [agents.length, fetchAgents]);

  useEffect(() => {
    if (!id || !sessionId) return;
    let mounted = true;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const sessions = await fetchSessions(id!);
        const allSessions = Array.isArray(sessions) ? sessions : [];
        const found = allSessions.find((entry: AgentSession) => entry.id === sessionId);
        if (!found) {
          if (mounted) setError('Session not found');
          return;
        }
        if (mounted) setSession(found);

        if (found.conversationId) {
          const msgs = await fetchMessages(id!, found.conversationId);
          if (mounted) {
            setMessages(
              Array.isArray(msgs)
                ? msgs.map((m: Record<string, unknown>, i: number) =>
                    normalizeConversationMessage(m, `msg-${i}`),
                  )
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
  }, [id, sessionId]);

  const agent = agents.find((a) => a.id === id);

  const duration = session
    ? formatDuration(session.startedAt, session.completedAt)
    : '';

  return (
    <div
      data-testid="session-detail-page"
      className="flex h-screen min-w-0 flex-col overflow-hidden bg-surface-950"
    >
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-surface-700 bg-surface-850">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-6">
           {/* Back */}
           <button
             type="button"
             data-testid="back-button"
             onClick={() => navigate(-1)}
             className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-800 hover:text-surface-200 transition-colors"
           >
             <ArrowLeft className="h-4 w-4" />
           </button>

          {/* Agent identity */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600/20 ring-1 ring-accent-500/30">
              <Bot className="h-4 w-4 text-accent-400" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-surface-200 leading-tight">
                {agent?.name ?? 'Agent'}
              </h1>
              {agent && (
                <div className="flex items-center gap-1.5 text-[11px] text-surface-400 leading-tight">
                  <Cpu className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate font-mono">{(agent.harnessConfig as Record<string, unknown>)?.model as string}</span>
                </div>
              )}
            </div>
          </div>

          {session && (
            <div className="ml-auto flex items-center gap-3">
              <RunStatusBadge status={session.status} />
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
        {session?.taskDescription && (
          <div className="border-t border-surface-700 bg-surface-850">
            <div className="mx-auto max-w-7xl px-6 py-2">
              <div className="max-h-24 overflow-y-auto">
                <p className="break-words whitespace-pre-wrap text-xs text-surface-400">
                  <span className="font-medium text-surface-300">Task:</span>{' '}
                   {session.taskDescription}
                </p>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
          </div>
        )}

        {error && (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <div
              data-testid="session-messages"
              className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-6 py-5"
          >
            <SessionThread
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
