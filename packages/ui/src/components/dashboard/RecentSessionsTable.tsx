import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import type { ConversationSummary } from '@stablehand/contracts';
import { StatusBadge } from './StatusBadge';
import { isTerminalConversationStatus } from '@/lib/lifecycle-status';
import { cn } from '@/lib/utils';
import {
  formatCompactNumber,
  formatDurationBetween,
  formatRunningDuration,
} from '@/lib/format';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { describeConversationCostRollup } from '@/lib/usage-cost';

type SessionFilter = 'all' | 'running' | 'errors' | 'background';

const FILTERS: Array<{ id: SessionFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'errors', label: 'Errors' },
  { id: 'background', label: 'Background' },
];

function matchesFilter(conv: ConversationSummary, filter: SessionFilter): boolean {
  switch (filter) {
    case 'running':
      return !isTerminalConversationStatus(conv.status);
    case 'errors':
      return conv.status === 'ERROR';
    case 'background':
      return conv.mode === 'background';
    default:
      return true;
  }
}

export interface RecentSessionsTableProps {
  conversations: ConversationSummary[];
  agentNameMap: Record<string, string>;
  onCancel?: (conv: ConversationSummary) => void;
  /** Hide the filter chips (used when the parent owns filtering). */
  showFilters?: boolean;
  emptyMessage?: string;
}

/**
 * The dashboard's session table: running sessions pinned first, then newest
 * activity. Rows navigate to the conversation; live rows can be cancelled.
 */
export function RecentSessionsTable({
  conversations,
  agentNameMap,
  onCancel,
  showFilters = true,
  emptyMessage = 'No sessions yet. Start a conversation from an agent to see it here.',
}: RecentSessionsTableProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<SessionFilter>('all');

  const rows = useMemo(() => {
    const filtered = conversations.filter((conv) => matchesFilter(conv, filter));
    return [...filtered].sort((a, b) => {
      const aRunning = isTerminalConversationStatus(a.status) ? 1 : 0;
      const bRunning = isTerminalConversationStatus(b.status) ? 1 : 0;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return b.updatedAt - a.updatedAt;
    });
  }, [conversations, filter]);

  return (
    <div data-testid="recent-sessions">
      {showFilters && (
        <div className="mb-3 flex items-center gap-1.5">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setFilter(entry.id)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                filter === entry.id
                  ? 'border-accent-400/60 bg-accent-400/10 text-accent-300'
                  : 'border-surface-700 text-surface-400 hover:text-surface-200',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="rounded-lg border border-surface-700 bg-surface-800/30 px-4 py-8 text-center text-sm text-surface-400">
          {emptyMessage}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-surface-700 bg-surface-800/30">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="bg-surface-800/50">
                <th className="border-b border-surface-700 px-4 py-2.5 text-label font-medium">Agent</th>
                <th className="border-b border-surface-700 px-4 py-2.5 text-label font-medium">Task</th>
                <th className="border-b border-surface-700 px-4 py-2.5 text-label font-medium">Status</th>
                <th className="border-b border-surface-700 px-4 py-2.5 text-right text-label font-medium">Turns</th>
                <th className="border-b border-surface-700 px-4 py-2.5 text-right text-label font-medium">Usage</th>
                <th className="border-b border-surface-700 px-4 py-2.5 text-right text-label font-medium">Duration</th>
                <th className="border-b border-surface-700 px-4 py-2.5 text-right text-label font-medium">Updated</th>
                <th className="border-b border-surface-700 px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-700/50">
              {rows.map((conv) => {
                const terminal = isTerminalConversationStatus(conv.status);
                const cost = describeConversationCostRollup(conv);
                return (
                  <tr
                    key={conv.id}
                    onClick={() => navigate(`/agents/${conv.agentId}/conversations/${conv.id}`)}
                    className="group cursor-pointer transition-colors hover:bg-surface-800/50"
                  >
                    <td className="px-4 py-2.5 text-sm font-medium text-surface-200">
                      {agentNameMap[conv.agentId] || conv.agentId}
                    </td>
                    <td className="px-4 py-2.5 text-sm text-surface-400">
                      <div className="max-w-[180px] truncate sm:max-w-[260px] md:max-w-sm">
                        {conv.taskDescription || '—'}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={conv.status} subject="Conversation" />
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm tabular-nums text-surface-400">
                      {conv.turnCount}
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm tabular-nums text-surface-400">
                      {conv.totalTokens !== null ? `${formatCompactNumber(conv.totalTokens)} tok` : '—'}
                      {cost && <span className="ml-2" title={cost.title}>{cost.label}</span>}
                    </td>
                    <td
                      data-testid="conversation-duration"
                      className="px-4 py-2.5 text-right text-sm tabular-nums text-surface-400"
                    >
                      {terminal
                        ? formatDurationBetween(conv.startedAt, conv.completedAt ?? conv.updatedAt)
                        : formatRunningDuration(conv.startedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-sm text-surface-500">
                      <RelativeTime timestamp={conv.updatedAt} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!terminal && onCancel && (
                        <button
                          type="button"
                          data-testid="cancel-run-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCancel(conv);
                          }}
                          className="rounded-md p-1.5 text-surface-400 transition-colors hover:bg-red-500/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                          title="Cancel session"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
