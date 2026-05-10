import { useState, useMemo, Fragment, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import { SessionStatusBadge } from './SessionStatusBadge';
import { cn } from '@/lib/utils';
import type { AgentSession } from '@/stores/agents';
import { restoreSandboxSession } from '@/lib/api';
import { formatTime, formatDuration } from './types';

/* ------------------------------------------------------------------ */
/*  AgentSessionsTab                                                   */
/* ------------------------------------------------------------------ */

const RUN_FILTERS = ['all', 'running', 'completed', 'error', 'cancelled'] as const;

export interface AgentSessionsTabProps {
  sessions: AgentSession[];
  loading: boolean;
  error?: string | null;
  filter: string;
  onFilterChange: (v: string) => void;
  agentId: string;
  /** Called when user wants to view files for a specific run session */
  onViewSessionFiles?: (sessionId: string) => void;
  onContinueSession?: (conversationId: string) => void;
  onRetry?: () => void;
}

export function AgentSessionsTab({
  sessions,
  loading,
  error,
  filter,
  onFilterChange,
  agentId,
  onViewSessionFiles,
  onContinueSession,
  onRetry,
}: AgentSessionsTabProps) {
  const [expandedConversationId, setExpandedConversationId] = useState<string | null>(null);
  // Per-session restore state (ADR 013). Map of sessionId → 'pending' | error message.
  const [restoreState, setRestoreState] = useState<Record<string, 'pending' | { error: string } | undefined>>({});
  // Toast on final restore failure (ADR 013: only show on terminal failure, not auto-transitions).
  const [restoreToast, setRestoreToast] = useState<string | null>(null);

  const handleRetryRestore = useCallback(async (entry: AgentSession) => {
    const sandboxSessionId = entry.sandboxSessionId ?? entry.id;
    if (!sandboxSessionId) return;
    setRestoreState((prev) => ({ ...prev, [entry.id]: 'pending' }));
    try {
      await restoreSandboxSession(agentId, sandboxSessionId);
      setRestoreState((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRestoreState((prev) => ({ ...prev, [entry.id]: { error: message } }));
      setRestoreToast(`Restore failed: ${message}`);
    }
  }, [agentId]);

  const groupedSessions = useMemo(() => {
    const grouped = new Map<string, AgentSession[]>();
    for (const session of sessions) {
      const conversationId = session.conversationId ?? 'unknown';
      const existing = grouped.get(conversationId) ?? [];
      existing.push(session);
      grouped.set(conversationId, existing);
    }
    return Array.from(grouped.entries()).map(([conversationId, sessionEntries]) => ({
      conversationId,
      startedAt: Math.min(...sessionEntries.map((entry) => entry.startedAt)),
      messageCount: Math.max(...sessionEntries.map((entry) => entry.messageCount ?? 0)),
      lastMessageAt: Math.max(...sessionEntries.map((entry) => entry.completedAt ?? entry.startedAt)),
      entries: sessionEntries.sort((a, b) => b.startedAt - a.startedAt),
    })).sort((a, b) => b.startedAt - a.startedAt);
  }, [sessions]);

  const handleToggleSession = (convId: string) => {
    setExpandedConversationId((prev) => (prev === convId ? null : convId));
  };

  void agentId;
  void onViewSessionFiles;

  return (
    <div data-testid="sessions-history" className="space-y-4">
      {restoreToast && (
        <div
          role="alert"
          data-testid="restore-failure-toast"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300"
        >
          <span>{restoreToast}</span>
          <button
            type="button"
            onClick={() => setRestoreToast(null)}
            className="rounded-md border border-red-400/30 px-2 py-1 text-xs text-red-100 transition-colors hover:bg-red-500/10"
            aria-label="Dismiss restore failure"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status filter */}
      <div className="flex gap-1.5 flex-wrap">
        {RUN_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => onFilterChange(f)}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium transition-colors border capitalize',
              filter === f
                ? 'bg-accent-600/20 border-accent-500/30 text-accent-300'
                : 'bg-surface-800/60 border-surface-700/40 text-surface-400 hover:text-surface-300',
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Conversations list */}
      {loading ? (
        <div className="text-center py-12 text-surface-400 text-sm">Loading conversations...</div>
      ) : error ? (
        <div
          role="alert"
          data-testid="sessions-load-error"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-6 text-center"
        >
          <p className="text-red-200 font-medium">Failed to load conversations</p>
          <p className="text-red-200/70 text-sm mt-1">{error}</p>
          <p className="text-surface-400 text-xs mt-2">
            This is a load failure, not an empty session list.
          </p>
          {onRetry && (
            <button
              type="button"
              data-testid="sessions-retry-button"
              onClick={onRetry}
              className="btn-secondary mt-4"
            >
              Retry
            </button>
          )}
        </div>
      ) : groupedSessions.length === 0 ? (
        <div data-testid="sessions-empty-state" className="text-center py-16">
          <p className="text-surface-400 font-medium">No conversations found</p>
          <p className="text-surface-400 text-sm mt-1">
            {filter === 'all' ? 'Start a conversation to view activity.' : `No ${filter} conversations.`}
          </p>
        </div>
      ) : (
        <div className="border border-surface-700 rounded-lg overflow-x-auto bg-surface-800/30">
          <table className="w-full text-left border-collapse min-w-[600px]">
            <thead>
              <tr className="bg-surface-800/50">
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Conversation</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Status</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Started</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Turns</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Messages</th>
                <th className="px-4 py-3 border-b border-surface-700"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {groupedSessions.map((session) => {
                const isExpanded = expandedConversationId === session.conversationId;
                const latestEntry = session.entries[0];

                return (
                  <Fragment key={session.conversationId}>
                    <tr
                      onClick={() => handleToggleSession(session.conversationId)}
                      className="hover:bg-surface-800/50 cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3 text-sm font-mono text-surface-300">
                        {session.conversationId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        <SessionStatusBadge
                          status={latestEntry.status}
                          lastRestoreError={latestEntry.lastRestoreError}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {formatTime(session.startedAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {session.entries.length}
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {session.messageCount}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-surface-400 inline-block" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-surface-400 inline-block" />
                        )}
                      </td>
                    </tr>

                    {/* Expanded conversation detail */}
                    {isExpanded && (
                      <tr className="bg-surface-900/30">
                        <td colSpan={6} className="p-0">
                          <div data-testid="session-detail" className="px-4 py-4 space-y-4 border-t border-surface-700/30">
                            {/* Conversation actions */}
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              {onContinueSession && (
                                 <button
                                   type="button"
                                   onClick={(e) => { e.stopPropagation(); onContinueSession(session.conversationId); }}
                                   className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600/20 border border-accent-500/30 px-3 py-1.5 text-xs font-medium text-accent-300 hover:bg-accent-600/30 transition-colors"
                                 >
                                   <MessageSquare className="h-3.5 w-3.5" />
                                   Continue Conversation
                                 </button>
                               )}
                            </div>

                            <div className="space-y-3">
                              <p className="text-[11px] text-surface-400 uppercase tracking-wider">Turns</p>
                              {session.entries.map((entry, idx) => {
                                const showRetryRestore = entry.status.toUpperCase() === 'CHECKPOINTED' && Boolean(entry.lastRestoreError);
                                const restore = restoreState[entry.id];
                                return (
                                  <div key={entry.id} className="border border-surface-700/50 rounded-lg bg-surface-800/40 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex items-center gap-3 flex-wrap">
                                        <span className="text-xs font-mono text-surface-400">Turn {idx + 1}</span>
                                        <SessionStatusBadge
                                          status={entry.status}
                                          lastRestoreError={entry.lastRestoreError}
                                        />
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {formatTime(entry.startedAt)}
                                        </span>
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {entry.completedAt ? formatDuration(entry.startedAt, entry.completedAt) : 'In progress...'}
                                        </span>
                                      </div>
                                      {showRetryRestore && (
                                        <button
                                          type="button"
                                          data-testid="retry-restore-button"
                                          onClick={(e) => { e.stopPropagation(); void handleRetryRestore(entry); }}
                                          disabled={restore === 'pending'}
                                          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                                          title={`Last restore error: ${entry.lastRestoreError}`}
                                        >
                                          <RefreshCw className={cn('h-3.5 w-3.5', restore === 'pending' && 'animate-spin')} />
                                          {restore === 'pending' ? 'Retrying…' : 'Retry restore'}
                                        </button>
                                      )}
                                    </div>

                                    {showRetryRestore && entry.lastRestoreError && (
                                      <p
                                        data-testid="restore-error-detail"
                                        className="text-[11px] text-red-300 bg-red-500/5 border border-red-500/20 rounded px-2 py-1"
                                      >
                                        Last restore error: {entry.lastRestoreError}
                                      </p>
                                    )}
                                    {restore && typeof restore === 'object' && (
                                      <p role="alert" className="text-[11px] text-red-300">
                                        Retry failed: {restore.error}
                                      </p>
                                    )}

                                    {/* Task description */}
                                    {entry.taskDescription && (
                                      <p className="text-sm text-surface-300 bg-surface-900/60 rounded px-2 py-1.5 border border-surface-700/30">
                                        {entry.taskDescription}
                                      </p>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
