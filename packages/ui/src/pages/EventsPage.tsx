import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { EventListInput } from '@ctxmill/contracts';
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
import { AlertBanner } from '@/components/ui/AlertBanner';
import { PageShell } from '@/components/ui/PageShell';
import { StatsRow } from '@/components/ui/StatsRow';
import { formatEventDuration, formatEventTime } from '@/lib/format';

/** Map time range labels to API values */
const TIME_RANGES = [
  { label: '1h', value: '1h', ms: 60 * 60 * 1000 },
  { label: '24h', value: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', value: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

const SUMMARY_LIMIT = 180;

function truncateSummary(value: string, limit = SUMMARY_LIMIT): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function parsePayload(payload: unknown): Record<string, unknown> | string {
  try {
    if (typeof payload === 'string') {
      const parsed = JSON.parse(payload) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? parsed as Record<string, unknown>
        : String(parsed);
    }
    if (typeof payload === 'object' && payload !== null) return payload as Record<string, unknown>;
  } catch {
    return String(payload);
  }
  return String(payload ?? '');
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordField(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseRecordField(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return truncateSummary(value, 48);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === 'object' && value !== null) return '{...}';
  if (value === null) return 'null';
  return String(value);
}

function summarizeRecord(obj: Record<string, unknown>, preferredKeys: string[] = []): string {
  for (const key of preferredKeys) {
    const value = stringField(obj, key);
    if (value) return truncateSummary(value);
  }

  const entries = Object.entries(obj).filter(([key]) => key !== 'timestamp');
  if (entries.length === 0) return '{}';

  return truncateSummary(
    entries
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${compactValue(value)}`)
      .join(', ')
      + (entries.length > 4 ? ` (+${entries.length - 4})` : ''),
  );
}

function summarizeToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '';
  return ` (${summarizeRecord(args)})`;
}

function summarizeMessageCommit(parsed: Record<string, unknown>): string {
  const role = stringField(parsed, 'role') ?? 'message';
  const content = stringField(parsed, 'content');
  if (content) return truncateSummary(`${role[0]?.toUpperCase() ?? 'M'}${role.slice(1)} message: ${content}`);

  const toolCalls = parsed.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const names = toolCalls
      .map((call) => typeof call === 'object' && call !== null ? stringField(call as Record<string, unknown>, 'name') : undefined)
      .filter((name): name is string => Boolean(name));
    if (names.length > 0) return truncateSummary(`${role} message: tool calls ${names.join(', ')}`);
  }
  return summarizeRecord(parsed, ['messageId', 'toolCallId']);
}

function summarizeRunState(parsed: Record<string, unknown>, state: 'queued' | 'started'): string {
  const mode = stringField(parsed, 'mode');
  const task = stringField(parsed, 'taskDescription') ?? stringField(parsed, 'task');
  return truncateSummary(`${mode === 'background' ? 'Background run' : 'Run'} ${state}${task ? `: ${task}` : ''}`);
}

/** Extract a human-readable summary from a JSON payload string. */
function extractSummary(type: string, payload: unknown): string {
  const parsed = parsePayload(payload);
  if (typeof parsed === 'string') return truncateSummary(parsed);

  switch (type) {
    case 'RUN_STARTED':
      return summarizeRunState(parsed, 'started');
    case 'RUN_FINISHED': {
      const status = stringField(parsed, 'status');
      const duration = formatEventDuration(numberField(parsed, 'durationMs'));
      return truncateSummary(`Run ${status ?? 'finished'}${duration ? ` in ${duration}` : ''}`);
    }
    case 'RUN_ERROR': {
      const message = stringField(parsed, 'message');
      return truncateSummary(`Run failed${message ? `: ${message}` : ''}`);
    }
    case 'TEXT_MESSAGE_START': {
      const role = stringField(parsed, 'role') ?? 'assistant';
      return truncateSummary(`${role[0]?.toUpperCase() ?? 'M'}${role.slice(1)} message started`);
    }
    case 'TEXT_MESSAGE_CONTENT': {
      const role = stringField(parsed, 'role');
      const delta = stringField(parsed, 'delta');
      return truncateSummary(`${role ? `${role[0]?.toUpperCase() ?? 'M'}${role.slice(1)} ` : ''}text${delta ? `: ${delta}` : ''}`);
    }
    case 'TEXT_MESSAGE_END': {
      const role = stringField(parsed, 'role') ?? 'assistant';
      return truncateSummary(`${role[0]?.toUpperCase() ?? 'M'}${role.slice(1)} message ended`);
    }
    case 'TOOL_CALL_START': {
      const toolName = stringField(parsed, 'toolCallName') ?? stringField(parsed, 'toolCallId') ?? 'tool';
      const approval = parsed.requiresApproval === true ? ' approval required' : '';
      return truncateSummary(`Tool started: ${toolName}${approval}${summarizeToolArgs(parseRecordField(parsed, 'args'))}`);
    }
    case 'TOOL_CALL_ARGS': {
      const toolName = stringField(parsed, 'toolCallName') ?? stringField(parsed, 'toolCallId') ?? 'tool';
      const args = parseRecordField(parsed, 'args') ?? parseRecordField(parsed, 'delta');
      return truncateSummary(`Tool args: ${toolName}${summarizeToolArgs(args)}`);
    }
    case 'TOOL_CALL_END': {
      const toolName = stringField(parsed, 'toolCallName') ?? stringField(parsed, 'toolCallId') ?? 'tool';
      return truncateSummary(`Tool ended: ${toolName}`);
    }
    case 'TOOL_CALL_RESULT': {
      const toolName = stringField(parsed, 'toolCallName') ?? stringField(parsed, 'toolCallId') ?? 'tool';
      const duration = formatEventDuration(numberField(parsed, 'durationMs'));
      const error = stringField(parsed, 'error');
      if (error) {
        return truncateSummary(`Tool failed: ${toolName} - ${error}${duration ? ` (${duration})` : ''}`);
      }
      const result = stringField(parsed, 'content');
      return truncateSummary(`Tool result: ${toolName}${duration ? ` (${duration})` : ''}${result ? ` - ${result}` : ''}`);
    }
    case 'CUSTOM': {
      const name = stringField(parsed, 'name') ?? 'custom';
      if (name === 'ctxmill.turn.pending') {
        return summarizeRunState(parsed, 'queued');
      }
      if (name === 'ctxmill.message.committed') {
        return summarizeMessageCommit(parsed);
      }
      if (name === 'ctxmill.interrupt.requested') {
        const toolName = stringField(parsed, 'toolCallName') ?? 'tool';
        return truncateSummary(`Approval requested: ${toolName}`);
      }
      if (name === 'ctxmill.interrupt.resolved') {
        const approved = parsed.approved === true ? 'approved' : parsed.approved === false ? 'rejected' : 'resolved';
        return truncateSummary(`Approval ${approved}`);
      }
      if (name === 'ctxmill.a2ui.render') {
        const block = recordField(parsed, 'block') ?? recordField(recordField(parsed, 'value') ?? {}, 'block');
        const component = block ? stringField(block, 'component') : undefined;
        return truncateSummary(`UI rendered${component ? `: ${component}` : ''}`);
      }
      const innerPayload = recordField(parsed, 'payload') ?? recordField(parsed, 'value');
      return truncateSummary(`Custom ${name}: ${innerPayload ? summarizeRecord(innerPayload) : summarizeRecord(parsed)}`);
    }
    default:
      return summarizeRecord(parsed, ['message', 'description', 'task', 'taskDescription', 'content', 'delta', 'name', 'type']);
  }
}

function formatEventPayload(payload: unknown): string {
  const rawPayload = typeof payload === 'object'
    ? JSON.stringify(payload)
    : String(payload ?? '');

  try {
    return JSON.stringify(JSON.parse(rawPayload), null, 2);
  } catch {
    return rawPayload;
  }
}

/** Canonical AG-UI run-channel frame types (ADR-015). */
function isRunFrameType(type: string): boolean {
  return type.startsWith('RUN_')
    || type.startsWith('TEXT_MESSAGE_')
    || type.startsWith('TOOL_CALL_')
    || type === 'CUSTOM'
    || type === 'STATE_DELTA'
    || type === 'MESSAGES_SNAPSHOT';
}

function isExecutionEventType(type: string): boolean {
  return ['turn.', 'message.', 'tool_call.', 'interrupt.', 'ag_ui.', 'user.']
    .some((prefix) => type.startsWith(prefix));
}

/** Category color mapping based on event type prefix. */
function typeColor(type: string): string {
  if (isExecutionEventType(type) || isRunFrameType(type)) return 'text-blue-400';
  if (type.startsWith('agent.')) return 'text-green-400';
  if (type.startsWith('feedback.')) return 'text-purple-400';
  if (type.startsWith('client.')) return 'text-cyan-400';
  return 'text-surface-300';
}

function typeBadgeBg(type: string): string {
  if (isExecutionEventType(type) || isRunFrameType(type)) return 'bg-blue-500/10 border-blue-500/20';
  if (type.startsWith('agent.')) return 'bg-green-500/10 border-green-500/20';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventTypesError, setEventTypesError] = useState<string | null>(null);

  // Filters. Turn/conversation scoping arrives via deep links from the turn
  // inspector, so those two live in the URL rather than local state.
  const [searchParams, setSearchParams] = useSearchParams();
  const turnIdFilter = searchParams.get('turnId') ?? '';
  const conversationIdFilter = searchParams.get('conversationId') ?? '';
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [agentFilter, setAgentFilter] = useState<string>(() => searchParams.get('agentId') ?? '');
  const [timeRange, setTimeRange] = useState<string>('24h');

  const clearScopeParam = useCallback((key: 'turnId' | 'conversationId') => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete(key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
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

  const loadEventTypes = useCallback(async () => {
    setEventTypesError(null);

    try {
      const data = await fetchEventTypes();
      setEventTypes(data.types);
    } catch (err) {
      console.debug('[Events] Event types load failed:', err);
      setEventTypes([]);
      setEventTypesError('Event type filters are unavailable.');
    }
  }, []);

  const loadEvents = useCallback(
    async (append = false, cursor?: number) => {
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
      }

      try {
        const [eventsData, statsData] = await Promise.all([
          fetchEvents({
            cursor,
            limit: 50,
            type: typeFilter || undefined,
            agentId: agentFilter || undefined,
            turnId: turnIdFilter || undefined,
            conversationId: conversationIdFilter || undefined,
            since: sinceMs,
          } as EventListInput),
          fetchEventStats(timeRange),
        ]);

        if (append) {
          setEvents((prev) => [...prev, ...eventsData.events]);
        } else {
          setEvents(eventsData.events);
        }
        setNextCursor(eventsData.nextCursor);
        setStats(statsData);
        setLoadError(null);
      } catch (err) {
        console.debug('[Events] Load failed:', err);
        setLoadError(append ? 'Failed to load more events.' : 'Failed to load event log.');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [typeFilter, agentFilter, turnIdFilter, conversationIdFilter, timeRange, sinceMs],
  );

  // Initial load + fetch agents and event types
  useEffect(() => {
    if (agents.length === 0) fetchAgents();
    void loadEventTypes();
  }, [agents.length, fetchAgents, loadEventTypes]);

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

  const hasLoadedEventData = events.length > 0 || stats !== null;

  const clearFilters = () => {
    setTypeFilter('');
    setAgentFilter('');
    setTimeRange('24h');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('turnId');
      next.delete('conversationId');
      next.delete('agentId');
      return next;
    }, { replace: true });
  };

  const hasActiveFilters = typeFilter || agentFilter || turnIdFilter || conversationIdFilter || timeRange !== '24h';

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
      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-5 sm:px-6">
        <div>
          <PageShell
            title="Event Log"
            description="Monitor event bus activity across all agents."
            actions={(
              <button
                type="button"
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={cn(
                  'inline-flex w-fit items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors',
                  autoRefresh
                    ? 'bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/30'
                    : 'bg-surface-800 text-surface-400 hover:text-surface-200',
                )}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', autoRefresh && 'animate-spin')} />
                <span className="hidden sm:inline">
                  {autoRefresh ? 'Auto-refresh on' : 'Auto-refresh'}
                </span>
                <span className="sm:hidden">{autoRefresh ? 'Auto on' : 'Auto'}</span>
              </button>
            )}
          />

          {stats && (
            <StatsRow
              items={[
                { label: 'Total Events', value: stats.total.toLocaleString() },
                { label: 'Events/min', value: stats.recentRate },
                { label: 'Event Types', value: Object.keys(stats.byType).length },
                { label: 'Active Agents', value: stats.topAgents.length },
              ]}
            />
          )}
        </div>

        {loadError && hasLoadedEventData && (
          <AlertBanner
            tone="error"
            message={loadError}
            actionLabel="Retry"
            onAction={() => loadEvents()}
            testId="events-retry-button"
          />
        )}

        {eventTypesError && (
          <AlertBanner
            tone="warning"
            message={eventTypesError}
            actionLabel="Retry"
            onAction={() => void loadEventTypes()}
            testId="events-type-retry-button"
          />
        )}

        {/* Filter bar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-1.5 text-xs text-surface-400">
            <Filter className="h-3.5 w-3.5" />
            <span>Filters</span>
          </div>

          {/* Event type filter */}
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50 sm:w-auto"
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
            className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50 sm:w-auto"
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
            className="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-accent-500/50 sm:w-auto"
          >
            <option value="none">No grouping</option>
            <option value="type">Group by type</option>
            <option value="agent">Group by agent</option>
          </select>

          {/* Turn / conversation scope chips (arrive via deep links) */}
          {turnIdFilter && (
            <span
              data-testid="events-turn-scope"
              className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/30 bg-accent-600/10 px-2.5 py-1 font-mono text-[11px] text-accent-300"
              title={turnIdFilter}
            >
              turn {turnIdFilter.slice(0, 8)}…
              <button
                type="button"
                onClick={() => clearScopeParam('turnId')}
                aria-label="Stop filtering by turn"
                className="text-accent-400 transition-colors hover:text-accent-200"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {conversationIdFilter && (
            <span
              data-testid="events-conversation-scope"
              className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/30 bg-accent-600/10 px-2.5 py-1 font-mono text-[11px] text-accent-300"
              title={conversationIdFilter}
            >
              conversation {conversationIdFilter.slice(0, 8)}…
              <button
                type="button"
                onClick={() => clearScopeParam('conversationId')}
                aria-label="Stop filtering by conversation"
                className="text-accent-400 transition-colors hover:text-accent-200"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}

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
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <Loader2 className="h-6 w-6 text-accent-400 animate-spin" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-surface-300">Loading event log</p>
              <p className="text-xs text-surface-500">
                Fetching recent events, stats, and filters for the selected range.
              </p>
            </div>
          </div>
        ) : loadError && !hasLoadedEventData ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <Activity className="h-8 w-8 text-red-300" />
            <div className="space-y-1">
              <p className="text-sm text-red-200">{loadError}</p>
              <p className="text-xs text-surface-400">
                The event log could not be loaded. Try again when the API is reachable.
              </p>
            </div>
            <button
              type="button"
              data-testid="events-retry-button"
              onClick={() => loadEvents()}
              className="btn-secondary"
            >
              Retry
            </button>
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
                <div className="flex items-center justify-between gap-3 px-4 py-3 bg-surface-800/50 border-b border-surface-700">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'break-all text-sm font-medium',
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
    <>
      <div data-testid="events-mobile-list" className="divide-y divide-surface-700/50 md:hidden">
        {events.map((ev) => {
          const isExpanded = expandedRow === ev.seq;
          return (
            <EventMobileRow
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
      </div>

      <div data-testid="events-desktop-table" className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[760px] text-left border-collapse">
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
      </div>
    </>
  );
}

/** Mobile event row with the same expandable payload details as the desktop table. */
function EventMobileRow({
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
  const formattedPayload = formatEventPayload(event.payload);
  const summary = extractSummary(event.type, event.payload);
  const displayAgent = agentName || event.agentId.slice(0, 8);

  return (
    <div className="bg-surface-900/10">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-3 text-left transition-colors hover:bg-surface-800/50 focus-visible:outline-none focus-visible:bg-surface-800/50"
      >
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            {showType && (
              <span
                className={cn(
                  'inline-flex min-w-0 max-w-full break-all rounded-md border px-2 py-0.5 text-[11px] font-medium',
                  typeBadgeBg(event.type),
                  typeColor(event.type),
                )}
              >
                {event.type}
              </span>
            )}

            <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-surface-500 tabular-nums">
              <span>{formatEventTime(event.createdAt)}</span>
              <span>#{event.seq}</span>
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-surface-400" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-surface-400" />
              )}
            </div>
          </div>

          <div className="break-words text-sm leading-5 text-surface-200">
            {summary || 'No event summary'}
          </div>

          {showAgent && (
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-surface-400">
              <span className="shrink-0 uppercase tracking-wider text-surface-500">Agent</span>
              <span className="min-w-0 truncate text-surface-300" title={displayAgent}>
                {displayAgent}
              </span>
            </div>
          )}

          {!showType && (
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-surface-400">
              <span className="shrink-0 uppercase tracking-wider text-surface-500">Type</span>
              <span className={cn('min-w-0 break-all', typeColor(event.type))}>
                {event.type}
              </span>
            </div>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-surface-700/50 bg-surface-900/50 px-4 py-3">
          <div className="mb-3 flex flex-col gap-1 text-xs text-surface-400">
            <span>
              <span className="text-surface-400">Agent ID:</span>{' '}
              <span className="break-all font-mono">{event.agentId}</span>
            </span>
            <span>
              <span className="text-surface-400">Timestamp:</span>{' '}
              <span className="tabular-nums">
                {new Date(event.createdAt).toISOString()}
              </span>
            </span>
          </div>
          <pre className="max-h-80 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-surface-700 bg-surface-950 p-3 font-mono text-xs leading-relaxed text-surface-300">
            {formattedPayload}
          </pre>
        </div>
      )}
    </div>
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
  const formattedPayload = formatEventPayload(event.payload);

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
          {formatEventTime(event.createdAt)}
        </td>
        {showType && (
          <td className="px-4 py-3">
            <span
              className={cn(
                'inline-flex max-w-[18rem] break-all rounded-md border px-2 py-0.5 text-[11px] font-medium',
                typeBadgeBg(event.type),
                typeColor(event.type),
              )}
            >
              {event.type}
            </span>
          </td>
        )}
        {showAgent && (
          <td className="px-4 py-3 text-sm text-surface-300 break-words">
            <Link
              to={`/agents/${event.agentId}`}
              onClick={(clickEvent) => clickEvent.stopPropagation()}
              className="hover:text-accent-300 hover:underline"
            >
              {agentName || event.agentId.slice(0, 8)}
            </Link>
          </td>
        )}
        <td className="px-4 py-3 text-sm text-surface-400">
          <div className="max-w-2xl whitespace-normal break-words leading-5 line-clamp-2">
            {extractSummary(event.type, event.payload)}
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
