import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Filter,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/stores/agents';
import {
  fetchEvents,
  fetchEventStats,
  fetchEventTypes,
  type EventRecord,
  type EventStats,
} from '@/lib/api';

/** Map time range labels to API values */
const TIME_RANGES = [
  { label: '1h', value: '1h', ms: 60 * 60 * 1000 },
  { label: '24h', value: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', value: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

/** Extract a human-readable summary from a JSON payload string. */
function extractSummary(payload: string | Record<string, unknown>): string {
  try {
    const obj = typeof payload === 'object' ? payload : JSON.parse(payload);
    if (typeof obj === 'string') return obj;
    // Look for common summary fields
    for (const key of ['message', 'description', 'task', 'taskDescription', 'content', 'name', 'error']) {
      if (typeof obj[key] === 'string' && obj[key].length > 0) {
        const val = obj[key] as string;
        return val.length > 120 ? val.slice(0, 117) + '...' : val;
      }
    }
    // Fall back to stringified keys
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    return keys.slice(0, 4).join(', ') + (keys.length > 4 ? ` (+${keys.length - 4})` : '');
  } catch {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return str.length > 120 ? str.slice(0, 117) + '...' : str;
  }
}

/** Format a timestamp to a readable relative or absolute string. */
function formatTime(ts: number): string {
  const elapsed = Date.now() - ts;
  if (elapsed < 60_000) return `${Math.max(0, Math.floor(elapsed / 1000))}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Category color mapping based on event type prefix. */
function typeColor(type: string): string {
  if (type.startsWith('run.')) return 'text-blue-400';
  if (type.startsWith('agent.')) return 'text-green-400';
  if (type.startsWith('learning.')) return 'text-amber-400';
  if (type.startsWith('feedback.')) return 'text-purple-400';
  if (type.startsWith('client.')) return 'text-cyan-400';
  return 'text-surface-300';
}

function typeBadgeBg(type: string): string {
  if (type.startsWith('run.')) return 'bg-blue-500/10 border-blue-500/20';
  if (type.startsWith('agent.')) return 'bg-green-500/10 border-green-500/20';
  if (type.startsWith('learning.')) return 'bg-amber-500/10 border-amber-500/20';
  if (type.startsWith('feedback.')) return 'bg-purple-500/10 border-purple-500/20';
  if (type.startsWith('client.')) return 'bg-cyan-500/10 border-cyan-500/20';
  return 'bg-surface-700/30 border-surface-600/30';
}

export function EventsPage() {
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const [events, setEvents] = useState<EventRecord[]>([]);
  const [stats, setStats] = useState<EventStats | null>(null);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | undefined>();

  // Filters
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [timeRange, setTimeRange] = useState<string>('24h');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [groupBy, setGroupBy] = useState<'none' | 'type' | 'agent'>('none');

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Agent name lookup
  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [agents]);

  const sinceMs = useMemo(() => {
    const range = TIME_RANGES.find((r) => r.value === timeRange);
    return range ? Date.now() - range.ms : undefined;
  }, [timeRange]);

  const loadEvents = useCallback(
    async (append = false, cursor?: number) => {
      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const [eventsData, statsData] = await Promise.all([
          fetchEvents({
            cursor,
            limit: 50,
            type: typeFilter || undefined,
            agentId: agentFilter || undefined,
            since: sinceMs,
          }),
          fetchEventStats(timeRange),
        ]);

        if (append) {
          setEvents((prev) => [...prev, ...eventsData.events]);
        } else {
          setEvents(eventsData.events);
        }
        setNextCursor(eventsData.nextCursor);
        setStats(statsData);
      } catch (err) {
        console.debug('[Events] Load failed:', err);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [typeFilter, agentFilter, timeRange, sinceMs],
  );

  // Initial load + fetch agents and event types
  useEffect(() => {
    if (agents.length === 0) fetchAgents();
    fetchEventTypes()
      .then((data) => setEventTypes(data.types))
      .catch(() => {});
  }, [agents.length, fetchAgents]);

  // Load events when filters change
  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => loadEvents(), 5000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, loadEvents]);

  const handleLoadMore = () => {
    if (nextCursor) loadEvents(true, nextCursor);
  };

  const clearFilters = () => {
    setTypeFilter('');
    setAgentFilter('');
    setTimeRange('24h');
  };

  const hasActiveFilters = typeFilter || agentFilter || timeRange !== '24h';

  // Grouped events
  const groupedEvents = useMemo(() => {
    if (groupBy === 'none') return null;
    const groups: Record<string, EventRecord[]> = {};
    for (const ev of events) {
      const key = groupBy === 'type' ? ev.type : (agentNameMap[ev.agentId] || ev.agentId);
      if (!groups[key]) groups[key] = [];
      groups[key]!.push(ev);
    }
    return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  }, [events, groupBy, agentNameMap]);

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-surface-200">
                Event Log
              </h2>
              <p className="mt-1.5 text-sm text-surface-400 max-w-lg">
                Monitor event bus activity across all agents.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                autoRefresh
                  ? 'bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/30'
                  : 'bg-surface-800 text-surface-400 hover:text-surface-200',
              )}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', autoRefresh && 'animate-spin')}
              />
              {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh'}
            </button>
          </div>

          {/* Stats row */}
          {stats && (
            <div className="mt-6 flex flex-col sm:flex-row items-stretch divide-y sm:divide-y-0 sm:divide-x divide-surface-700">
              <div className="flex-1 p-4 first:pl-0">
                <p className="text-label">Total Events</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.total.toLocaleString()}
                </p>
              </div>
              <div className="flex-1 p-4">
                <p className="text-label">Events/min</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.recentRate}
                </p>
              </div>
              <div className="flex-1 p-4">
                <p className="text-label">Event Types</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {Object.keys(stats.byType).length}
                </p>
              </div>
              <div className="flex-1 p-4">
                <p className="text-label">Active Agents</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-surface-100">
                  {stats.topAgents.length}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-surface-400">
            <Filter className="h-3.5 w-3.5" />
            <span>Filters</span>
          </div>

          {/* Event type filter */}
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50"
          >
            <option value="">All types</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          {/* Agent filter */}
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          {/* Time range */}
          <div className="flex rounded-lg border border-surface-700 overflow-hidden">
            {TIME_RANGES.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setTimeRange(r.value)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  timeRange === r.value
                    ? 'bg-surface-700 text-surface-100'
                    : 'bg-surface-800 text-surface-400 hover:text-surface-200',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Group by */}
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as 'none' | 'type' | 'agent')}
            className="rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50"
          >
            <option value="none">No grouping</option>
            <option value="type">Group by type</option>
            <option value="agent">Group by agent</option>
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>

        {/* Event table */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Activity className="h-8 w-8 text-surface-400 mb-3" />
            <p className="text-sm text-surface-400">No events found</p>
            <p className="text-xs text-surface-400 mt-1">
              Events will appear here as agents process tasks.
            </p>
          </div>
        ) : groupBy !== 'none' && groupedEvents ? (
          /* Grouped view */
          <div className="space-y-4">
            {groupedEvents.map(([group, groupEvents]) => (
              <div
                key={group}
                className="border border-surface-700 rounded-lg overflow-hidden bg-surface-800/30"
              >
                <div className="flex items-center justify-between px-4 py-3 bg-surface-800/50 border-b border-surface-700">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'text-sm font-medium',
                        groupBy === 'type' ? typeColor(group) : 'text-surface-200',
                      )}
                    >
                      {group}
                    </span>
                    <span className="rounded-full bg-surface-700/50 px-2 py-0.5 text-[10px] font-medium text-surface-400">
                      {groupEvents.length}
                    </span>
                  </div>
                </div>
                <EventTable
                  events={groupEvents}
                  expandedRow={expandedRow}
                  onToggleRow={setExpandedRow}
                  agentNameMap={agentNameMap}
                  showType={groupBy !== 'type'}
                  showAgent={groupBy !== 'agent'}
                />
              </div>
            ))}
          </div>
        ) : (
          /* Flat view */
          <div className="border border-surface-700 rounded-lg overflow-hidden bg-surface-800/30">
            <EventTable
              events={events}
              expandedRow={expandedRow}
              onToggleRow={setExpandedRow}
              agentNameMap={agentNameMap}
              showType
              showAgent
            />
          </div>
        )}

        {/* Load more */}
        {nextCursor && (
          <div className="flex justify-center pt-2 pb-4">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="flex items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-4 py-2 text-xs font-medium text-surface-300 hover:text-surface-100 hover:bg-surface-700 transition-colors disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              Load more
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

/** Reusable event table component used in both flat and grouped views. */
function EventTable({
  events,
  expandedRow,
  onToggleRow,
  agentNameMap,
  showType,
  showAgent,
}: {
  events: EventRecord[];
  expandedRow: number | null;
  onToggleRow: (seq: number | null) => void;
  agentNameMap: Record<string, string>;
  showType: boolean;
  showAgent: boolean;
}) {
  return (
    <table className="w-full text-left border-collapse">
      <thead>
        <tr className="bg-surface-800/50">
          <th className="w-8 px-3 py-3 border-b border-surface-700" />
          <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">
            Time
          </th>
          {showType && (
            <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">
              Type
            </th>
          )}
          {showAgent && (
            <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">
              Agent
            </th>
          )}
          <th className="px-4 py-3 text-label border-b border-surface-700 font-medium">
            Summary
          </th>
          <th className="px-4 py-3 text-label border-b border-surface-700 font-medium text-right tabular-nums">
            Seq
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-surface-700/50">
        {events.map((ev) => {
          const isExpanded = expandedRow === ev.seq;
          return (
            <EventRow
              key={ev.seq}
              event={ev}
              isExpanded={isExpanded}
              onToggle={() => onToggleRow(isExpanded ? null : ev.seq)}
              agentName={agentNameMap[ev.agentId]}
              showType={showType}
              showAgent={showAgent}
            />
          );
        })}
      </tbody>
    </table>
  );
}

/** Single event row with expandable payload viewer. */
function EventRow({
  event,
  isExpanded,
  onToggle,
  agentName,
  showType,
  showAgent,
}: {
  event: EventRecord;
  isExpanded: boolean;
  onToggle: () => void;
  agentName?: string;
  showType: boolean;
  showAgent: boolean;
}) {
  const colSpan = 3 + (showType ? 1 : 0) + (showAgent ? 1 : 0);

  const rawPayload = typeof event.payload === 'object' ? JSON.stringify(event.payload) : event.payload;
  let formattedPayload: string;
  try {
    formattedPayload = JSON.stringify(JSON.parse(rawPayload), null, 2);
  } catch {
    formattedPayload = rawPayload;
  }

  return (
    <>
      <tr
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="hover:bg-surface-800/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:bg-surface-800/50"
      >
        <td className="px-3 py-3 text-surface-400">
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </td>
        <td className="px-4 py-3 text-xs text-surface-400 tabular-nums whitespace-nowrap">
          {formatTime(event.createdAt)}
        </td>
        {showType && (
          <td className="px-4 py-3">
            <span
              className={cn(
                'inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium',
                typeBadgeBg(event.type),
                typeColor(event.type),
              )}
            >
              {event.type}
            </span>
          </td>
        )}
        {showAgent && (
          <td className="px-4 py-3 text-sm text-surface-300">
            {agentName || event.agentId.slice(0, 8)}
          </td>
        )}
        <td className="px-4 py-3 text-sm text-surface-400">
          <div className="max-w-xs md:max-w-md truncate">
            {extractSummary(event.payload)}
          </div>
        </td>
        <td className="px-4 py-3 text-xs text-surface-400 tabular-nums text-right">
          #{event.seq}
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={colSpan} className="bg-surface-900/50 px-6 py-4">
            <div className="space-y-2">
              <div className="flex items-center gap-4 text-xs text-surface-400">
                <span>
                  <span className="text-surface-400">Agent ID:</span>{' '}
                  <span className="font-mono">{event.agentId}</span>
                </span>
                <span>
                  <span className="text-surface-400">Timestamp:</span>{' '}
                  <span className="tabular-nums">
                    {new Date(event.createdAt).toISOString()}
                  </span>
                </span>
              </div>
              <pre className="overflow-x-auto rounded-lg bg-surface-950 border border-surface-700 p-4 text-xs text-surface-300 font-mono leading-relaxed max-h-80">
                {formattedPayload}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
