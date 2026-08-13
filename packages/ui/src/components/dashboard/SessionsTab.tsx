import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationSummary } from '@ctxmill/contracts';
import { fetchRecentConversations } from '@/lib/api';
import { useAgentsStore } from '@/stores/agents';
import { RecentSessionsTable } from './RecentSessionsTable';

const PAGE_SIZE = 50;

/**
 * Full session browser: newest first across all agents, agent filter, and
 * cursor-based "load older" paging on top of /api/conversations/recent.
 */
export function SessionsTab({ agentNameMap }: { agentNameMap: Record<string, string> }) {
  const agents = useAgentsStore((s) => s.agents);
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(async (options: { before?: number; reset?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const { conversations: page } = await fetchRecentConversations({
        limit: PAGE_SIZE,
        ...(options.before !== undefined ? { before: options.before } : {}),
        ...(agentFilter ? { agentId: agentFilter } : {}),
      });
      setExhausted(page.length < PAGE_SIZE);
      setConversations((prev) => {
        if (options.reset) return page;
        const merged = new Map(prev.map((conv) => [conv.id, conv]));
        for (const conv of page) merged.set(conv.id, conv);
        return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [agentFilter]);

  useEffect(() => {
    void load({ reset: true });
  }, [load]);

  const oldestUpdatedAt = useMemo(
    () => (conversations.length > 0
      ? Math.min(...conversations.map((conv) => conv.updatedAt))
      : undefined),
    [conversations],
  );

  return (
    <div className="space-y-3" data-testid="sessions-tab">
      <div className="flex items-center gap-3">
        <label className="text-xs text-surface-400" htmlFor="sessions-agent-filter">Agent</label>
        <select
          id="sessions-agent-filter"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="rounded-md border border-surface-700 bg-surface-800 px-2 py-1 text-sm text-surface-200"
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}</option>
          ))}
        </select>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Failed to load sessions: {error}
        </div>
      )}
      <RecentSessionsTable
        conversations={conversations}
        agentNameMap={agentNameMap}
        emptyMessage={loading ? 'Loading sessions…' : 'No sessions found.'}
      />
      {!exhausted && conversations.length > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => void load({ before: oldestUpdatedAt })}
            className="rounded-md border border-surface-700 px-4 py-1.5 text-sm text-surface-300 transition-colors hover:bg-surface-800 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load older sessions'}
          </button>
        </div>
      )}
    </div>
  );
}
