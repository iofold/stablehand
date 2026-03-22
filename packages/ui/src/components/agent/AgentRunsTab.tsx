import { useState, useMemo, useEffect, useCallback, Fragment } from 'react';
import {
  Clock,
  Activity,
  ChevronDown,
  ChevronRight,
  Wrench,
  CheckCircle,
  GitMerge,
  GitFork,
  Trash2,
  FileSearch,
  Loader2,
  X,
  FolderOpen,
  MessageSquare,
} from 'lucide-react';
import { RunStatusBadge } from '@/components/dashboard/RunStatusBadge';
import { cn } from '@/lib/utils';
import {
  fetchSessionDiff,
  promoteSession,
  forkSession,
  discardSession,
} from '@/lib/api';
import type { FileDiff } from '@/lib/api';
import type { AgentRun } from '@/stores/agents';
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
            key={`${step.ordinal}-${idx}`}
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
/*  SessionDiffPanel                                                    */
/* ------------------------------------------------------------------ */

function SessionDiffPanel({ agentId, runId }: { agentId: string; runId: string }) {
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    fetchSessionDiff(agentId, runId)
      .then((d) => { if (mounted) setDiffs(d); })
      .catch((err) => { if (mounted) setError(String(err)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [agentId, runId]);

  if (loading) return <div className="text-surface-400 text-sm py-2">Loading diff...</div>;
  if (error) return <div className="text-red-400 text-sm py-2">Failed to load diff</div>;
  if (diffs.length === 0) return <div className="text-surface-400 text-sm py-2">No changes in this session</div>;

  return (
    <div className="space-y-1 py-2">
      <p className="text-[11px] text-surface-400 uppercase tracking-wider mb-2">Session Changes</p>
      {diffs.map((d) => (
        <div key={d.path} className="flex items-center gap-2 text-sm font-mono">
          <span className={cn(
            d.type === 'added' ? 'text-green-400' :
            d.type === 'modified' ? 'text-amber-400' :
            'text-red-400',
          )}>
            {d.type === 'added' ? '+' : d.type === 'modified' ? '~' : '-'}
          </span>
          <span className="text-surface-300">{d.path}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SessionActions                                                      */
/* ------------------------------------------------------------------ */

function SessionActions({
  agentId,
  runId,
  onViewFiles,
}: {
  agentId: string;
  runId: string;
  onViewFiles?: (runId: string) => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [forkName, setForkName] = useState('');
  const [showForkInput, setShowForkInput] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handlePromote = useCallback(async () => {
    if (!confirm('Promote session changes to the base workspace? This cannot be undone.')) return;
    setActionLoading('promote');
    setResult(null);
    try {
      const r = await promoteSession(agentId, runId);
      setResult(`Promoted: ${r.added} added, ${r.modified} modified, ${r.deleted} deleted`);
    } catch (err) {
      setResult(`Promote failed: ${err}`);
    } finally {
      setActionLoading(null);
    }
  }, [agentId, runId]);

  const handleDiscard = useCallback(async () => {
    if (!confirm('Discard all session changes? This cannot be undone.')) return;
    setActionLoading('discard');
    setResult(null);
    try {
      await discardSession(agentId, runId);
      setResult('Session discarded');
    } catch (err) {
      setResult(`Discard failed: ${err}`);
    } finally {
      setActionLoading(null);
    }
  }, [agentId, runId]);

  const handleFork = useCallback(async () => {
    if (!forkName.trim()) return;
    setActionLoading('fork');
    setResult(null);
    try {
      const r = await forkSession(agentId, runId, forkName.trim());
      setResult(`Forked to new agent: ${r.agentId}`);
      setShowForkInput(false);
      setForkName('');
    } catch (err) {
      setResult(`Fork failed: ${err}`);
    } finally {
      setActionLoading(null);
    }
  }, [agentId, runId, forkName]);

  return (
    <div className="space-y-3">
      {/* Session status badge */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-accent-900/30 border border-accent-700/30 px-2 py-0.5 text-[11px] font-medium text-accent-300">
          <FolderOpen className="h-3 w-3" />
          Session workspace
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShowDiff((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-surface-700/40 bg-surface-800/60 px-2.5 py-1.5 text-xs font-medium text-surface-300 hover:bg-surface-700/60 transition-colors"
        >
          <FileSearch className="h-3.5 w-3.5" />
          {showDiff ? 'Hide Diff' : 'View Diff'}
        </button>

        {onViewFiles && (
          <button
            type="button"
            onClick={() => onViewFiles(runId)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-surface-700/40 bg-surface-800/60 px-2.5 py-1.5 text-xs font-medium text-surface-300 hover:bg-surface-700/60 transition-colors"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Browse Files
          </button>
        )}

        <button
          type="button"
          onClick={handlePromote}
          disabled={actionLoading !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-green-700/40 bg-green-900/20 px-2.5 py-1.5 text-xs font-medium text-green-300 hover:bg-green-900/30 transition-colors disabled:opacity-40"
        >
          {actionLoading === 'promote' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />}
          Promote
        </button>

        <button
          type="button"
          onClick={() => setShowForkInput((v) => !v)}
          disabled={actionLoading !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-accent-700/40 bg-accent-900/20 px-2.5 py-1.5 text-xs font-medium text-accent-300 hover:bg-accent-900/30 transition-colors disabled:opacity-40"
        >
          <GitFork className="h-3.5 w-3.5" />
          Fork
        </button>

        <button
          type="button"
          onClick={handleDiscard}
          disabled={actionLoading !== null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-700/40 bg-red-900/20 px-2.5 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/30 transition-colors disabled:opacity-40"
        >
          {actionLoading === 'discard' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Discard
        </button>
      </div>

      {/* Fork name input */}
      {showForkInput && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={forkName}
            onChange={(e) => setForkName(e.target.value)}
            placeholder="New agent name..."
            className="flex-1 rounded-lg border border-surface-600/40 bg-surface-800/60 px-3 py-1.5 text-sm text-surface-200 placeholder-surface-400 focus:outline-none focus:border-accent-500/50 focus:ring-1 focus:ring-accent-500/30"
          />
          <button
            type="button"
            onClick={handleFork}
            disabled={!forkName.trim() || actionLoading !== null}
            className="rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-500 transition-colors disabled:opacity-40"
          >
            {actionLoading === 'fork' ? 'Forking...' : 'Create Fork'}
          </button>
          <button
            type="button"
            onClick={() => { setShowForkInput(false); setForkName(''); }}
            className="rounded-lg p-1.5 text-surface-400 hover:text-surface-200 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Diff panel */}
      {showDiff && <SessionDiffPanel agentId={agentId} runId={runId} />}

      {/* Result message */}
      {result && (
        <div className={cn(
          'text-xs px-3 py-2 rounded-lg border',
          result.includes('failed')
            ? 'bg-red-900/20 border-red-700/30 text-red-300'
            : 'bg-green-900/20 border-green-700/30 text-green-300',
        )}>
          {result}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentSessionsTab                                                   */
/* ------------------------------------------------------------------ */

const RUN_FILTERS = ['all', 'running', 'completed', 'error', 'cancelled'] as const;

export interface AgentSessionsTabProps {
  runs: AgentRun[];
  loading: boolean;
  filter: string;
  onFilterChange: (v: string) => void;
  agentId: string;
  traces: Trace[];
  /** Called when user wants to view files for a specific run session */
  onViewSessionFiles?: (runId: string) => void;
  /** Called when user wants to continue chat for a session */
  onContinueChat?: (conversationId: string) => void;
}

export function AgentSessionsTab({
  runs,
  loading,
  filter,
  onFilterChange,
  agentId,
  traces,
  onViewSessionFiles,
  onContinueChat,
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

  const sessions = useMemo(() => {
    const grouped = new Map<string, AgentRun[]>();
    for (const run of runs) {
      const convId = run.conversationId ?? 'unknown';
      const existing = grouped.get(convId) ?? [];
      existing.push(run);
      grouped.set(convId, existing);
    }
    return Array.from(grouped.entries()).map(([convId, sessionRuns]) => ({
      conversationId: convId,
      startedAt: Math.min(...sessionRuns.map(r => r.startedAt)),
      messageCount: sessionRuns.reduce((acc, r) => {
        const trace = traceByRunId[r.id];
        return acc + (trace?.steps?.length || 0);
      }, 0),
      lastMessageAt: Math.max(...sessionRuns.map(r => r.completedAt ?? r.startedAt)),
      runs: sessionRuns.sort((a, b) => a.startedAt - b.startedAt),
    })).sort((a, b) => b.startedAt - a.startedAt);
  }, [runs, traceByRunId]);

  const handleToggleSession = (convId: string) => {
    setExpandedSessionId((prev) => (prev === convId ? null : convId));
  };

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
      ) : sessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-surface-400 font-medium">No sessions found</p>
          <p className="text-surface-400 text-sm mt-1">
            {filter === 'all' ? 'Start a new run to view activity and traces.' : `No ${filter} sessions.`}
          </p>
        </div>
      ) : (
        <div className="border border-surface-700 rounded-lg overflow-x-auto bg-surface-800/30">
          <table className="w-full text-left border-collapse min-w-[600px]">
            <thead>
              <tr className="bg-surface-800/50">
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Session ID</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Status</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Started</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Runs</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Messages</th>
                <th className="px-4 py-3 border-b border-surface-700"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {sessions.map((session) => {
                const isExpanded = expandedSessionId === session.conversationId;
                const latestRun = session.runs[session.runs.length - 1];

                return (
                  <Fragment key={session.conversationId}>
                    <tr
                      role="button"
                      tabIndex={0}
                      onClick={() => handleToggleSession(session.conversationId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleToggleSession(session.conversationId);
                        }
                      }}
                      className="hover:bg-surface-800/50 cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3 text-sm font-mono text-surface-300">
                        {session.conversationId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        <RunStatusBadge status={latestRun.status} />
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {formatTime(session.startedAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {session.runs.length}
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
                              {onContinueChat && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); onContinueChat(session.conversationId); }}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600/20 border border-accent-500/30 px-3 py-1.5 text-xs font-medium text-accent-300 hover:bg-accent-600/30 transition-colors"
                                >
                                  <MessageSquare className="h-3.5 w-3.5" />
                                  Continue Chat
                                </button>
                              )}
                            </div>
                            {(latestRun.status === 'completed' || latestRun.status === 'error') && (
                              <SessionActions
                                agentId={agentId}
                                runId={latestRun.id}
                                onViewFiles={onViewSessionFiles}
                              />
                            )}

                            {/* Nested runs */}
                            <div className="space-y-3">
                              <p className="text-[11px] text-surface-400 uppercase tracking-wider">Session Runs</p>
                              {session.runs.map((run, idx) => {
                                const trace = traceByRunId[run.id];
                                return (
                                  <div key={run.id} className="border border-surface-700/50 rounded-lg bg-surface-800/40 p-3 space-y-3">
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <span className="text-xs font-mono text-surface-400">Run {idx + 1}</span>
                                        <RunStatusBadge status={run.status} />
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {formatTime(run.startedAt)}
                                        </span>
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {run.completedAt ? formatDuration(run.startedAt, run.completedAt) : 'In progress...'}
                                        </span>
                                      </div>
                                    </div>
                                    
                                    {/* Task description */}
                                    {(run.taskDescription || trace?.taskDescription) && (
                                      <p className="text-sm text-surface-300 bg-surface-900/60 rounded px-2 py-1.5 border border-surface-700/30">
                                        {run.taskDescription || trace?.taskDescription}
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
