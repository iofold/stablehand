import { useState, useMemo, Fragment } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Wrench,
  CheckCircle,
  MessageSquare,
} from 'lucide-react';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { cn } from '@/lib/utils';
import type { AgentSession } from '@/stores/agents';
import type { Trace, TraceStep } from './types';
import { formatTime, formatDuration } from './types';

/* ------------------------------------------------------------------ */
/*  TraceTimeline                                                      */
/* ------------------------------------------------------------------ */

function TraceTimeline({ steps }: { steps: TraceStep[] }) {
  const sortedSteps = useMemo(
    () => [...steps].sort((a, b) => a.ordinal - b.ordinal),
    [steps],
  );

  return (
    <div data-testid="trace-timeline" className="relative">
      {sortedSteps.map((step, idx) => {
        const isToolCall = step.type === 'tool_call';
        const isLast = idx === sortedSteps.length - 1;

        return (
          <div
            key={`${step.ordinal}-${step.type}-${step.content}`}
            data-testid="trace-step"
            className="relative flex gap-3"
          >
            {/* Vertical line + dot */}
            <div className="flex flex-col items-center flex-shrink-0">
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border',
                  isToolCall
                    ? 'bg-accent-900/30 border-accent-700/30'
                    : 'bg-emerald-900/30 border-emerald-700/30',
                )}
              >
                {isToolCall ? (
                  <Wrench className="h-3.5 w-3.5 text-accent-400" />
                ) : (
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                )}
              </div>
              {!isLast && (
                <div className="w-px flex-1 min-h-[16px] bg-surface-700/50" />
              )}
            </div>

            {/* Step content */}
            <div className={cn('flex-1 pb-3', isLast ? 'pb-0' : '')}>
              <div
                className={cn(
                  'rounded-lg border px-3 py-2',
                  isToolCall
                    ? 'bg-accent-900/30 border-accent-700/30'
                    : 'bg-emerald-900/30 border-emerald-700/30',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-surface-400 tabular-nums flex-shrink-0">
                      #{step.ordinal}
                    </span>
                    <span className={cn(
                      'text-xs font-medium truncate',
                      isToolCall ? 'text-accent-300' : 'text-emerald-300',
                    )}>
                      {isToolCall ? 'Tool Call' : 'Tool Result'}
                    </span>
                  </div>
                  {step.durationMs != null && (
                    <span className="inline-flex items-center rounded-full bg-surface-800/60 border border-surface-700/40 px-1.5 py-0.5 text-[10px] text-surface-400 tabular-nums flex-shrink-0">
                      {step.durationMs}ms
                    </span>
                  )}
                </div>
                <p className="text-sm text-surface-300 mt-1 break-words line-clamp-3">
                  {step.content}
                </p>
                {isToolCall && step.metadata?.args != null && (
                  <pre className="text-[11px] text-surface-500 font-mono mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap">
                    {typeof step.metadata.args === 'string' 
                      ? step.metadata.args 
                      : JSON.stringify(step.metadata.args, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentSessionsTab                                                   */
/* ------------------------------------------------------------------ */

const RUN_FILTERS = ['all', 'running', 'completed', 'error', 'cancelled'] as const;

export interface AgentSessionsTabProps {
  sessions: AgentSession[];
  loading: boolean;
  filter: string;
  onFilterChange: (v: string) => void;
  agentId: string;
  traces: Trace[];
  /** Called when user wants to view files for a specific run session */
  onViewSessionFiles?: (runId: string) => void;
  onContinueSession?: (sessionId: string) => void;
}

export function AgentSessionsTab({
  sessions,
  loading,
  filter,
  onFilterChange,
  agentId,
  traces,
  onViewSessionFiles,
  onContinueSession,
}: AgentSessionsTabProps) {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  // Build a map of runId -> trace for fast lookup
  const traceByRunId = useMemo(() => {
    const map: Record<string, Trace> = {};
    for (const trace of traces) {
      if (trace.runId) {
        map[trace.runId] = trace;
      }
    }
    return map;
  }, [traces]);

  const groupedSessions = useMemo(() => {
    const grouped = new Map<string, AgentSession[]>();
    for (const session of sessions) {
      const sessionId = session.conversationId ?? 'unknown';
      const existing = grouped.get(sessionId) ?? [];
      existing.push(session);
      grouped.set(sessionId, existing);
    }
    return Array.from(grouped.entries()).map(([sessionId, sessionEntries]) => ({
      sessionId,
      startedAt: Math.min(...sessionEntries.map((entry) => entry.startedAt)),
      messageCount: sessionEntries.reduce((acc, entry) => {
        const trace = traceByRunId[entry.id];
        return acc + (trace?.steps?.length || 0);
      }, 0),
      lastMessageAt: Math.max(...sessionEntries.map((entry) => entry.completedAt ?? entry.startedAt)),
      entries: sessionEntries.sort((a, b) => b.startedAt - a.startedAt),
    })).sort((a, b) => b.startedAt - a.startedAt);
  }, [sessions, traceByRunId]);

  const handleToggleSession = (convId: string) => {
    setExpandedSessionId((prev) => (prev === convId ? null : convId));
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

      {/* Sessions list */}
      {loading ? (
        <div className="text-center py-12 text-surface-400 text-sm">Loading sessions...</div>
      ) : groupedSessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-surface-400 font-medium">No sessions found</p>
          <p className="text-surface-400 text-sm mt-1">
            {filter === 'all' ? 'Start a session to view activity and traces.' : `No ${filter} sessions.`}
          </p>
        </div>
      ) : (
        <div className="border border-surface-700 rounded-lg overflow-x-auto bg-surface-800/30">
          <table className="w-full text-left border-collapse min-w-[600px]">
            <thead>
              <tr className="bg-surface-800/50">
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Session</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Status</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Started</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Turns</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Messages</th>
                <th className="px-4 py-3 border-b border-surface-700"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {groupedSessions.map((session) => {
                const isExpanded = expandedSessionId === session.sessionId;
                const latestEntry = session.entries[0];

                return (
                  <Fragment key={session.sessionId}>
                    <tr
                      onClick={() => handleToggleSession(session.sessionId)}
                      className="hover:bg-surface-800/50 cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3 text-sm font-mono text-surface-300">
                        {session.sessionId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        <RunStatusBadge status={latestEntry.status} />
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

                    {/* Expanded session detail */}
                    {isExpanded && (
                      <tr className="bg-surface-900/30">
                        <td colSpan={6} className="p-0">
                          <div data-testid="session-detail" className="px-4 py-4 space-y-4 border-t border-surface-700/30">
                            {/* Session actions */}
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              {onContinueSession && (
                                 <button
                                   type="button"
                                   onClick={(e) => { e.stopPropagation(); onContinueSession(session.sessionId); }}
                                   className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600/20 border border-accent-500/30 px-3 py-1.5 text-xs font-medium text-accent-300 hover:bg-accent-600/30 transition-colors"
                                 >
                                   <MessageSquare className="h-3.5 w-3.5" />
                                   Continue Session
                                 </button>
                               )}
                            </div>

                            <div className="space-y-3">
                              <p className="text-[11px] text-surface-400 uppercase tracking-wider">Turns</p>
                              {session.entries.map((entry, idx) => {
                                const trace = traceByRunId[entry.id];
                                return (
                                  <div key={entry.id} className="border border-surface-700/50 rounded-lg bg-surface-800/40 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <span className="text-xs font-mono text-surface-400">Turn {idx + 1}</span>
                                        <RunStatusBadge status={entry.status} />
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {formatTime(entry.startedAt)}
                                        </span>
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {entry.completedAt ? formatDuration(entry.startedAt, entry.completedAt) : 'In progress...'}
                                        </span>
                                      </div>
                                    </div>
                                    
                                    {/* Task description */}
                                    {(entry.taskDescription || trace?.taskDescription) && (
                                      <p className="text-sm text-surface-300 bg-surface-900/60 rounded px-2 py-1.5 border border-surface-700/30">
                                        {entry.taskDescription || trace?.taskDescription}
                                      </p>
                                    )}

                                    {/* Trace timeline */}
                                    {trace && trace.steps && trace.steps.length > 0 && (
                                      <div className="mt-2 pl-2 border-l-2 border-surface-700/30">
                                        <TraceTimeline steps={trace.steps} />
                                      </div>
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
