import { useState, useMemo, Fragment } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
} from 'lucide-react';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { cn } from '@/lib/utils';
import type { AgentSession } from '@/stores/agents';
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
}: AgentSessionsTabProps) {
  const [expandedConversationId, setExpandedConversationId] = useState<string | null>(null);

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
      messageCount: sessionEntries.reduce((acc, entry) => {
        return acc + (entry.messageCount ?? 0);
      }, 0),
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
        <div role="alert" className="text-center py-16">
          <p className="text-red-300 font-medium">Failed to load conversations</p>
          <p className="text-surface-400 text-sm mt-1">{error}</p>
        </div>
      ) : groupedSessions.length === 0 ? (
        <div className="text-center py-16">
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
                        <RunStatusBadge status={latestEntry.status} pausedReason={latestEntry.pausedReason} />
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
                                return (
                                  <div key={entry.id} className="border border-surface-700/50 rounded-lg bg-surface-800/40 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <span className="text-xs font-mono text-surface-400">Turn {idx + 1}</span>
                                        <RunStatusBadge status={entry.status} pausedReason={entry.pausedReason} />
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {formatTime(entry.startedAt)}
                                        </span>
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {entry.completedAt ? formatDuration(entry.startedAt, entry.completedAt) : 'In progress...'}
                                        </span>
                                      </div>
                                    </div>
                                    
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
