import { useState, useMemo, Fragment, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Info,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import { TurnStatusBadge } from './TurnStatusBadge';
import { cn } from '@/lib/utils';
import type { AgentTurn } from '@/stores/agents';
import { restoreSandboxSession } from '@/lib/api';
import { formatCompactNumber, formatDurationBetween } from '@/lib/format';
import { userVisibleTags } from '@/lib/tags';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { describeTurnCost, summarizeTurnCosts } from '@/lib/usage-cost';

/* ------------------------------------------------------------------ */
/*  AgentTurnsTab                                                      */
/* ------------------------------------------------------------------ */

const TURN_FILTERS = ['all', 'queued', 'running', 'completed', 'error', 'cancelled', 'incomplete-cost'] as const;

const TURN_FILTER_LABELS: Partial<Record<(typeof TURN_FILTERS)[number], string>> = {
  'incomplete-cost': 'costs incomplete',
};

export interface AgentTurnsTabProps {
  turns: AgentTurn[];
  loading: boolean;
  error?: string | null;
  filter: string;
  onFilterChange: (v: string) => void;
  agentId: string;
  /** Called when the user wants to inspect a conversation workspace. */
  onViewConversationFiles?: (conversationId: string) => void;
  onContinueConversation?: (conversationId: string) => void;
  onRetry?: () => void;
  /** Opens the turn inspector panel for one turn. */
  onInspectTurn?: (turnId: string) => void;
}

export function AgentTurnsTab({
  turns,
  loading,
  error,
  filter,
  onFilterChange,
  agentId,
  onViewConversationFiles,
  onContinueConversation,
  onRetry,
  onInspectTurn,
}: AgentTurnsTabProps) {
  const [expandedConversationId, setExpandedConversationId] = useState<string | null>(null);
  // Per-turn restore request state (ADR 013). Map of turnId → pending or an error.
  const [restoreState, setRestoreState] = useState<Record<string, 'pending' | { error: string } | undefined>>({});
  // Toast on final restore failure (ADR 013: only show on terminal failure, not auto-transitions).
  const [restoreToast, setRestoreToast] = useState<string | null>(null);

  const handleRetryRestore = useCallback(async (entry: AgentTurn) => {
    const sandboxSessionId = entry.sandboxSessionId;
    if (!sandboxSessionId) return;
    setRestoreState((prev) => ({ ...prev, [entry.id]: 'pending' }));
    try {
      await restoreSandboxSession(agentId, sandboxSessionId);
      setRestoreState((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
      onRetry?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setRestoreState((prev) => ({ ...prev, [entry.id]: { error: message } }));
      setRestoreToast(`Restore failed: ${message}`);
    }
  }, [agentId, onRetry]);

  const groupedConversations = useMemo(() => {
    const grouped = new Map<string, AgentTurn[]>();
    for (const turn of turns) {
      const conversationId = turn.conversationId ?? 'unknown';
      const existing = grouped.get(conversationId) ?? [];
      existing.push(turn);
      grouped.set(conversationId, existing);
    }
    return Array.from(grouped.entries()).map(([conversationId, conversationTurns]) => ({
      conversationId,
      startedAt: Math.min(...conversationTurns.map((entry) => entry.startedAt)),
      conversationMessageCount: Math.max(...conversationTurns.map((entry) => entry.conversationMessageCount ?? 0)),
      lastMessageAt: Math.max(...conversationTurns.map((entry) => entry.completedAt ?? entry.startedAt)),
      totalTokens: conversationTurns.reduce((sum, entry) => sum + (entry.usage?.totalTokens ?? 0), 0),
      cost: summarizeTurnCosts(conversationTurns.map((entry) => entry.usage)),
      entries: conversationTurns.sort((a, b) => b.startedAt - a.startedAt),
    })).sort((a, b) => b.startedAt - a.startedAt);
  }, [turns]);

  const handleToggleConversation = (conversationId: string) => {
    setExpandedConversationId((previous) => (
      previous === conversationId ? null : conversationId
    ));
  };

  return (
    <div data-testid="turns-history" className="space-y-4">
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
        {TURN_FILTERS.map((f) => (
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
            {TURN_FILTER_LABELS[f] ?? f}
          </button>
        ))}
      </div>

      {/* Conversations list */}
      {loading ? (
        <div className="text-center py-12 text-surface-400 text-sm">Loading conversations...</div>
      ) : error ? (
        <div
          role="alert"
          data-testid="turns-load-error"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-6 text-center"
        >
          <p className="text-red-200 font-medium">Failed to load conversations</p>
          <p className="text-red-200/70 text-sm mt-1">{error}</p>
          <p className="text-surface-400 text-xs mt-2">
            This is a load failure, not an empty turn list.
          </p>
          {onRetry && (
            <button
              type="button"
              data-testid="turns-retry-button"
              onClick={onRetry}
              className="btn-secondary mt-4"
            >
              Retry
            </button>
          )}
        </div>
      ) : groupedConversations.length === 0 ? (
        <div data-testid="turns-empty-state" className="text-center py-16">
          <p className="text-surface-400 font-medium">No turns found</p>
          <p className="text-surface-400 text-sm mt-1">
            {filter === 'all' ? 'Start a turn to view activity.' : `No ${filter} turns.`}
          </p>
        </div>
      ) : (
        <div className="border border-surface-700 rounded-lg overflow-x-auto bg-surface-800/30">
          <table className="w-full text-left border-collapse min-w-[760px]">
            <thead>
              <tr className="bg-surface-800/50">
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Conversation</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Status</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Started</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Last activity</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Turns</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Messages</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Tokens</th>
                <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">Model cost</th>
                <th className="px-4 py-3 border-b border-surface-700"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {groupedConversations.map((conversation) => {
                const isExpanded = expandedConversationId === conversation.conversationId;
                const latestEntry = conversation.entries[0];

                return (
                  <Fragment key={conversation.conversationId}>
                    <tr
                      onClick={() => handleToggleConversation(conversation.conversationId)}
                      className="hover:bg-surface-800/50 cursor-pointer transition-colors group"
                    >
                      <td className="px-4 py-3 text-sm font-mono text-surface-300">
                        {conversation.conversationId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        <TurnStatusBadge
                          status={latestEntry.status}
                          sandboxStatus={latestEntry.sandboxStatus}
                          lastRestoreError={latestEntry.lastRestoreError}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        <RelativeTime timestamp={conversation.startedAt} />
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        <RelativeTime timestamp={conversation.lastMessageAt} />
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {conversation.entries.length}
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {conversation.conversationMessageCount}
                      </td>
                      <td className="px-4 py-3 text-sm text-surface-400 tabular-nums">
                        {conversation.totalTokens > 0
                          ? <span title={`${conversation.totalTokens.toLocaleString()} tokens`}>{formatCompactNumber(conversation.totalTokens)}</span>
                          : '--'}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-3 text-xs tabular-nums',
                          conversation.cost.state === 'complete'
                            ? 'text-emerald-300'
                            : conversation.cost.state === 'pending'
                              ? 'text-blue-300'
                              : conversation.cost.state === 'partial'
                                ? 'text-amber-300'
                                : 'text-surface-400',
                        )}
                        title={conversation.cost.title}
                      >
                        {conversation.cost.label}
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
                        <td colSpan={9} className="p-0">
                          <div data-testid="conversation-detail" className="px-4 py-4 space-y-4 border-t border-surface-700/30">
                            {/* Conversation actions */}
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                              {onContinueConversation && (
                                 <button
                                   type="button"
                                   onClick={(e) => { e.stopPropagation(); onContinueConversation(conversation.conversationId); }}
                                   className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600/20 border border-accent-500/30 px-3 py-1.5 text-xs font-medium text-accent-300 hover:bg-accent-600/30 transition-colors"
                                 >
                                   <MessageSquare className="h-3.5 w-3.5" />
                                   Continue Conversation
                                 </button>
                               )}
                              {onViewConversationFiles && (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onViewConversationFiles(conversation.conversationId);
                                  }}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-surface-600 px-3 py-1.5 text-xs font-medium text-surface-300 transition-colors hover:bg-surface-800"
                                >
                                  View Workspace
                                </button>
                              )}
                            </div>

                            <div className="space-y-3">
                              <p className="text-[11px] text-surface-400 uppercase tracking-wider">Turns</p>
                              {conversation.entries.map((entry, idx) => {
                                const turnCost = describeTurnCost(entry.usage);
                                const showRetryRestore =
                                  entry.sandboxStatus === 'CHECKPOINTED'
                                  && Boolean(entry.lastRestoreError)
                                  && Boolean(entry.sandboxSessionId);
                                const restore = restoreState[entry.id];
                                return (
                                  <div key={entry.id} className="border border-surface-700/50 rounded-lg bg-surface-800/40 p-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex items-center gap-3 flex-wrap">
                                        <span className="text-xs font-mono text-surface-400">Turn {idx + 1}</span>
                                        <TurnStatusBadge
                                          status={entry.status}
                                          sandboxStatus={entry.sandboxStatus}
                                          lastRestoreError={entry.lastRestoreError}
                                        />
                                        <RelativeTime timestamp={entry.startedAt} className="text-xs text-surface-400 tabular-nums" />
                                        <span className="text-xs text-surface-400 tabular-nums">
                                          {entry.completedAt ? formatDurationBetween(entry.startedAt, entry.completedAt) : 'In progress...'}
                                        </span>
                                        {(entry.usage?.totalTokens ?? 0) > 0 && (
                                          <span
                                            className="text-xs text-surface-400 tabular-nums"
                                            title={`${entry.usage!.inputTokens.toLocaleString()} in / ${entry.usage!.outputTokens.toLocaleString()} out`}
                                          >
                                            {formatCompactNumber(entry.usage!.totalTokens)} tok
                                          </span>
                                        )}
                                        <span
                                          data-testid="turn-cost"
                                          className={cn(
                                            'rounded-full border px-2 py-0.5 text-[11px] tabular-nums',
                                            turnCost.state === 'complete'
                                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                              : turnCost.state === 'pending'
                                                ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                                                : turnCost.state === 'partial'
                                                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                                                  : 'border-surface-600 bg-surface-700/30 text-surface-400',
                                          )}
                                          title={turnCost.title}
                                        >
                                          {turnCost.label}
                                        </span>
                                        {userVisibleTags(entry.tags).map(([key, value]) => (
                                          <span
                                            key={key}
                                            className="rounded-full border border-surface-600/50 bg-surface-800/70 px-2 py-0.5 font-mono text-[10px] text-surface-400"
                                            title="Budget-attribution tag"
                                          >
                                            {key}={value}
                                          </span>
                                        ))}
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                      {onInspectTurn && (
                                        <button
                                          type="button"
                                          data-testid="turn-inspect-button"
                                          onClick={(e) => { e.stopPropagation(); onInspectTurn(entry.id); }}
                                          title="Turn details"
                                          aria-label={`Details for turn ${idx + 1}`}
                                          className="rounded p-1 text-surface-500 transition-colors hover:bg-surface-700/60 hover:text-surface-200"
                                        >
                                          <Info className="h-3.5 w-3.5" />
                                        </button>
                                      )}
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
