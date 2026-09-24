import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  AnalyticsOverview,
  AnalyticsWindow,
  ConversationSummary,
  ModelGatewayStatus,
} from '@stablehand/contracts';
import { useAgentsStore } from '@/stores/agents';
import { Dashboard } from '@/components/dashboard/Dashboard';
import { RecentSessionsTable } from '@/components/dashboard/RecentSessionsTable';
import { ActivityChart } from '@/components/dashboard/ActivityChart';
import { TopAgentsPanel } from '@/components/dashboard/TopAgentsPanel';
import { SessionsTab } from '@/components/dashboard/SessionsTab';
import {
  fetchAnalyticsOverview,
  fetchModelGatewayStatus,
  fetchQueueStatus,
  fetchRecentConversations,
  type QueueStatus,
} from '@/lib/api';
import { useApiAuthStore } from '@/lib/auth';
import { isTerminalConversationStatus } from '@/lib/lifecycle-status';
import { PageShell } from '@/components/ui/PageShell';
import { StatsRow } from '@/components/ui/StatsRow';
import { cn } from '@/lib/utils';
import { formatCompactNumber } from '@/lib/format';

const TABS = [
  { id: 'overview', label: 'Overview', testId: 'dashboard-tab-overview' },
  { id: 'agents', label: 'Agents', testId: 'dashboard-tab-agents' },
  { id: 'sessions', label: 'Sessions', testId: 'dashboard-tab-sessions' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const WINDOW_LABELS: Record<AnalyticsWindow, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};

export function DashboardPage() {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const cancelTurn = useAgentsStore((s) => s.cancelTurn);
  const agentLoadError = useAgentsStore((s) => s.error);
  const authRequired = useApiAuthStore((s) => s.authRequired);
  const displayLoading = authRequired || loading;

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = TABS.some((tab) => tab.id === tabParam)
    ? (tabParam as TabId)
    : 'overview';
  const setActiveTab = (tab: TabId) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'overview') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      return next;
    }, { replace: true });
  };

  const [recentConversations, setRecentConversations] = useState<ConversationSummary[]>([]);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [analyticsWindow, setAnalyticsWindow] = useState<AnalyticsWindow>('24h');
  const [gateway, setGateway] = useState<ModelGatewayStatus | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      if (useApiAuthStore.getState().authRequired) return;

      const [agentsResult, recent, analytics, gatewayStatus, queueStatus] = await Promise.allSettled([
        fetchAgents(),
        // Ten rows keeps the activity chart near the fold; the Sessions tab
        // owns depth.
        fetchRecentConversations({ limit: 10 }),
        fetchAnalyticsOverview(analyticsWindow),
        fetchModelGatewayStatus(),
        fetchQueueStatus(),
      ]);
      void agentsResult;
      if (!mounted) return;
      if (recent.status === 'fulfilled') setRecentConversations(recent.value.conversations);
      if (analytics.status === 'fulfilled') setOverview(analytics.value);
      if (gatewayStatus.status === 'fulfilled') setGateway(gatewayStatus.value);
      if (queueStatus.status === 'fulfilled') setQueue(queueStatus.value);
      setOverviewLoading(false);
    }

    setOverviewLoading(true);
    void poll();
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [fetchAgents, authRequired, analyticsWindow]);

  const agentNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) map[a.id] = a.name;
    return map;
  }, [agents]);

  const runningCount = useMemo(
    () => recentConversations.filter((conv) => !isTerminalConversationStatus(conv.status)).length,
    [recentConversations],
  );

  const attention = useMemo(() => {
    const notes: string[] = [];
    if (gateway?.enabled && gateway.state === 'degraded') {
      notes.push('Model spend tracking is degraded — recent runs may be missing cost data.');
    }
    if (queue && queue.queuedTurns > 0 && queue.dispatcher.stalled) {
      notes.push(`${queue.queuedTurns} queued run(s) are waiting but the dispatcher has stalled.`);
    }
    return notes;
  }, [gateway, queue]);

  const totals = overview?.totals ?? null;

  const handleCancelRun = async (conv: ConversationSummary) => {
    setCancelError(null);
    try {
      if (conv.latestTurnId) {
        await cancelTurn(conv.agentId, conv.latestTurnId);
      }
      setRecentConversations((prev) => prev.filter((entry) => entry.id !== conv.id));
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-surface-950">
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5">
        <PageShell title="Agent Dashboard" description="What your agents are doing right now." />

        <div className="mt-4 border-b border-surface-700">
          <div className="flex overflow-x-auto overflow-y-hidden">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={tab.testId}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'shrink-0 -mb-px border-b-2 px-4 py-2.5 text-sm transition-colors',
                    isActive
                      ? 'border-accent-400 text-surface-100'
                      : 'border-transparent text-surface-400 hover:text-surface-200',
                  )}
                >
                  {tab.label}
                  {tab.id === 'agents' && !displayLoading && ` (${agents.length})`}
                </button>
              );
            })}
          </div>
        </div>

        {activeTab === 'overview' && (
          <div className="space-y-6 py-5">
            <StatsRow
              items={[
                { label: 'Running now', value: overviewLoading && runningCount === 0 ? '--' : runningCount },
                {
                  label: `Runs · ${WINDOW_LABELS[analyticsWindow]}`,
                  value: totals ? (
                    <>
                      {formatCompactNumber(totals.turns)}
                      {totals.errorTurns > 0 && (
                        <span className="ml-2 text-base font-medium text-red-400">
                          {formatCompactNumber(totals.errorTurns)} failed
                        </span>
                      )}
                    </>
                  ) : '--',
                },
                {
                  label: `Tokens · ${WINDOW_LABELS[analyticsWindow]}`,
                  value: totals ? formatCompactNumber(totals.totalTokens) : '--',
                },
                {
                  label: `Spend · ${WINDOW_LABELS[analyticsWindow]}`,
                  value: totals ? `$${totals.knownCostUsd.toFixed(2)}` : '--',
                },
                {
                  label: 'Agents',
                  value: totals
                    ? `${totals.activeAgents}/${totals.agents}`
                    : displayLoading ? '--' : agents.length,
                },
                {
                  label: 'Queued',
                  value: queue ? (
                    <>
                      {queue.queuedTurns}
                      <span
                        data-testid="gateway-health-dot"
                        title={gateway?.enabled ? `Spend tracking: ${gateway.state}` : 'Spend tracking off'}
                        className={cn(
                          'ml-2 inline-block h-2.5 w-2.5 rounded-full align-middle',
                          gateway?.enabled && gateway.state === 'healthy' && 'bg-teal-400',
                          gateway?.enabled && gateway.state !== 'healthy' && 'bg-amber-400',
                          !gateway?.enabled && 'bg-surface-600',
                        )}
                      />
                    </>
                  ) : '--',
                },
              ]}
            />

            {attention.length > 0 && (
              <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                {attention.map((note) => <div key={note}>{note}</div>)}
              </div>
            )}

            {cancelError && (
              <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                Failed to cancel session: {cancelError}
              </div>
            )}

            <div data-testid="active-sessions-section">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium text-surface-300">Recent sessions</h3>
                <button
                  type="button"
                  onClick={() => setActiveTab('sessions')}
                  className="text-xs text-accent-300 transition-colors hover:text-accent-200"
                >
                  Browse all sessions →
                </button>
              </div>
              <RecentSessionsTable
                conversations={recentConversations}
                agentNameMap={agentNameMap}
                onCancel={(conv) => void handleCancelRun(conv)}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
              <ActivityChart
                overview={overview}
                window={analyticsWindow}
                onWindowChange={setAnalyticsWindow}
                loading={overviewLoading}
              />
              <TopAgentsPanel
                agents={overview?.agents ?? []}
                loading={overviewLoading}
                windowLabel={WINDOW_LABELS[analyticsWindow]}
              />
            </div>
          </div>
        )}

        {activeTab === 'agents' && (
          <div className="py-5">
            <Dashboard
              agents={agents}
              loading={displayLoading}
              error={authRequired ? null : agentLoadError}
              onRetry={() => { void fetchAgents(); }}
            />
          </div>
        )}

        {activeTab === 'sessions' && (
          <div className="py-5">
            <SessionsTab agentNameMap={agentNameMap} />
          </div>
        )}
      </main>
    </div>
  );
}
