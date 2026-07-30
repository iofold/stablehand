import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  ChartNoAxesCombined,
  CheckCircle2,
  RefreshCw,
} from 'lucide-react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  AgentBudgetStatus,
  AnalyticsOverview,
  AnalyticsWindow,
  BudgetPolicy,
  ModelGatewayQuarantine,
  ModelGatewayStatus,
} from '@ctxmill/contracts';

import {
  fetchAgentBudgetStatuses,
  fetchAnalyticsOverview,
  fetchBudgetPolicies,
  fetchModelGatewayQuarantine,
  fetchModelGatewayStatus,
} from '@/lib/api';
import { BudgetPolicyLedger } from '@/components/analytics/BudgetPolicyLedger';
import { formatCompactNumber, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const WINDOWS: Array<{ value: AnalyticsWindow; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

const COVERAGE_TONES = {
  complete: 'bg-accent-400',
  partial: 'bg-amber-400',
  pending: 'bg-sky-400',
  unpriced: 'bg-rose-400',
} as const;

function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return `$${value.toPrecision(2)}`;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}`;
}

function formatChartLabel(timestamp: number, window: AnalyticsWindow): string {
  return new Date(timestamp).toLocaleString(undefined, window === '24h'
    ? { hour: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

function windowDescription(window: AnalyticsWindow): string {
  if (window === '24h') return 'the last 24 hours';
  if (window === '7d') return 'the last 7 days';
  return 'the last 30 days';
}

function describeGatewayState(gateway: ModelGatewayStatus | null): string {
  if (!gateway) return 'Cost tracking unavailable';
  if (gateway.state === 'degraded') {
    return gateway.enabled ? 'Cost tracking delayed' : 'Cost tracking off with unpriced runs';
  }
  if (!gateway.enabled || gateway.state === 'disabled') return 'Direct metering — no gateway';
  if (gateway.state === 'healthy') return 'Cost tracking up to date';
  if (gateway.state === 'initializing') return 'Cost tracking starting';
  return 'Cost tracking delayed';
}

const QUARANTINE_REASON_LABELS: Record<string, string> = {
  invalid_payload: 'malformed record',
  missing_correlation: 'no run reference',
  invalid_correlation: 'unreadable run reference',
  correlation_mismatch: 'run reference mismatch',
  unknown_turn: 'no matching run',
};

function quarantineBreakdownTitle(quarantine: ModelGatewayQuarantine | null): string | undefined {
  if (!quarantine || quarantine.reasons.length === 0) return undefined;
  return quarantine.reasons
    .map((row) => `${row.total} × ${QUARANTINE_REASON_LABELS[row.reason] ?? row.reason}`)
    .join(' · ');
}

function describeQuarantineRecency(quarantine: ModelGatewayQuarantine | null): string {
  if (!quarantine) return '';
  return quarantine.recentTotal > 0
    ? ` (${quarantine.recentTotal} new in the last 24h)`
    : ' (none recent)';
}

function stateTone(state: 'ok' | 'warning' | 'blocked'): string {
  if (state === 'blocked') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  if (state === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-accent-500/25 bg-accent-500/10 text-accent-300';
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 py-4 sm:px-5 sm:first:pl-0">
      <p className="text-label">{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold tabular-nums text-surface-100">
        {value}
      </p>
      <p className="mt-1 truncate text-xs text-surface-400">{detail}</p>
    </div>
  );
}

function Panel({
  title,
  eyebrow,
  children,
  className,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(
      'overflow-hidden rounded-xl border border-surface-700/70 bg-surface-850/80',
      className,
    )}>
      <div className="flex items-start justify-between border-b border-surface-700/60 px-5 py-4">
        <div>
          {eyebrow ? <p className="text-label">{eyebrow}</p> : null}
          <h2 className={cn('text-base font-semibold text-surface-200', eyebrow && 'mt-1')}>
            {title}
          </h2>
        </div>
      </div>
      {children}
    </section>
  );
}

export function AnalyticsPage() {
  const navigate = useNavigate();
  const [window, setWindow] = useState<AnalyticsWindow>('24h');
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [policies, setPolicies] = useState<BudgetPolicy[] | null>(null);
  const [budgetStatuses, setBudgetStatuses] = useState<AgentBudgetStatus[] | null>(null);
  const [gateway, setGateway] = useState<ModelGatewayStatus | null>(null);
  const [quarantine, setQuarantine] = useState<ModelGatewayQuarantine | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [supplementalWarning, setSupplementalWarning] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [showAllAgents, setShowAllAgents] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSupplementalWarning(false);

    void Promise.allSettled([
      fetchAnalyticsOverview(window),
      fetchBudgetPolicies(),
      fetchAgentBudgetStatuses(),
      fetchModelGatewayStatus(),
      fetchModelGatewayQuarantine(),
    ]).then(([analyticsResult, policiesResult, statusesResult, gatewayResult, quarantineResult]) => {
      if (cancelled) return;

      if (analyticsResult.status === 'fulfilled') {
        setOverview(analyticsResult.value);
        setUpdatedAt(Date.now());
      } else {
        setError(analyticsResult.reason instanceof Error
          ? analyticsResult.reason.message
          : 'Analytics could not be loaded.');
      }
      setPolicies(policiesResult.status === 'fulfilled' ? policiesResult.value : null);
      setBudgetStatuses(statusesResult.status === 'fulfilled' ? statusesResult.value : null);
      setGateway(gatewayResult.status === 'fulfilled' ? gatewayResult.value : null);
      setQuarantine(quarantineResult.status === 'fulfilled' ? quarantineResult.value : null);
      setSupplementalWarning(
        policiesResult.status === 'rejected'
        || statusesResult.status === 'rejected'
        || gatewayResult.status === 'rejected',
      );
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [refreshRevision, window]);

  const chartData = useMemo(() => overview?.activity.map((bucket) => ({
    ...bucket,
    label: formatChartLabel(bucket.from, window),
  })) ?? [], [overview, window]);

  const budgetByAgent = useMemo(
    () => new Map(budgetStatuses?.map((status) => [status.agentId, status]) ?? []),
    [budgetStatuses],
  );

  if (!overview && loading) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-[1500px] px-5 py-7 sm:px-8">
        <p className="text-label">Operations / Analytics</p>
        <h1 className="mt-2 text-3xl font-semibold text-surface-100">Runtime analytics</h1>
        <div className="mt-8 space-y-4" aria-label="Loading analytics">
          <div className="h-24 animate-pulse rounded-xl bg-surface-800/60" />
          <div className="h-80 animate-pulse rounded-xl bg-surface-800/60" />
          <p className="text-sm text-surface-400">Loading usage, cost, and run activity…</p>
        </div>
      </main>
    );
  }

  if (!overview) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-7 sm:px-8">
        <p className="text-label">Operations / Analytics</p>
        <h1 className="mt-2 text-3xl font-semibold text-surface-100">Runtime analytics</h1>
        <div role="alert" className="mt-8 rounded-xl border border-rose-500/30 bg-rose-500/10 p-6">
          <div className="flex items-center gap-3 text-rose-300">
            <AlertTriangle className="h-5 w-5" />
            <p className="font-medium">Analytics are temporarily unavailable.</p>
          </div>
          <p className="mt-2 text-sm text-surface-300">{error}</p>
          <button
            type="button"
            onClick={() => setRefreshRevision((revision) => revision + 1)}
            className="btn-secondary mt-4"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  const { totals } = overview;
  const completeCoverage = totals.turns === 0
    ? 0
    : Math.round((totals.costCoverage.complete / totals.turns) * 100);
  const tokenCoverage = totals.turns === 0
    ? 0
    : Math.round((totals.tokenReportedTurns / totals.turns) * 100);
  const enabledPolicies = policies?.filter((policy) => policy.enabled) ?? [];
  const maxAgentActivity = Math.max(
    1,
    ...overview.agents.map((agent) => agent.totalTokens || agent.turns),
  );
  const visibleAgents = showAllAgents
    ? overview.agents
    : overview.agents.slice(0, 20);

  return (
    <main className="mx-auto min-h-screen w-full max-w-[1500px] px-5 py-7 sm:px-8 lg:px-10">
      <header className="flex flex-col gap-5 border-b border-surface-700/60 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-label">Operations / Analytics</p>
          <h1 className="mt-2 flex items-center gap-3 text-3xl font-semibold tracking-tight text-surface-100">
            <ChartNoAxesCombined className="h-7 w-7 text-accent-400" />
            Runtime analytics
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-surface-400">
            Turn throughput, model usage, cost coverage, and budget pressure from canonical runtime records.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div
            className="inline-flex rounded-lg border border-surface-700 bg-surface-900/80 p-1"
            aria-label="Analytics window"
          >
            {WINDOWS.map((option) => (
              <button
                key={option.value}
                type="button"
                data-analytics-window={option.value}
                aria-pressed={window === option.value}
                onClick={() => setWindow(option.value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  window === option.value
                    ? 'bg-surface-700 text-surface-100 shadow-sm'
                    : 'text-surface-400 hover:text-surface-200',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Refresh analytics"
            onClick={() => setRefreshRevision((revision) => revision + 1)}
            disabled={loading}
            className="btn-secondary px-3 py-2"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </header>

      {supplementalWarning ? (
        <div role="status" className="mt-5 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Budget and gateway health is temporarily unavailable. Core activity remains current.
        </div>
      ) : null}
      {gateway && gateway.awaitingTurns > 0 && gateway.state === 'degraded' ? (
        <div
          role="alert"
          data-testid="gateway-degraded-banner"
          className="mt-5 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {gateway.awaitingTurns} completed {gateway.awaitingTurns === 1 ? 'run has' : 'runs have'} no
            model prices yet
            {gateway.oldestAwaitingAt != null
              ? ` (oldest from ${new Date(gateway.oldestAwaitingAt).toLocaleString()})`
              : ''}
            . Spend totals and budget limits are under-counting until prices sync.
          </span>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="mt-5 flex items-center gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Refresh failed. Showing the last successfully loaded analytics.
        </div>
      ) : null}

      <section className="grid grid-cols-2 divide-x-0 divide-y divide-surface-700/60 border-b border-surface-700/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0 xl:grid-cols-5">
        <Metric
          label="Turns"
          value={formatCompactNumber(totals.turns)}
          detail={`${totals.completedTurns} completed · ${totals.errorTurns} errors`}
        />
        <Metric
          label="Reported tokens"
          value={formatCompactNumber(totals.totalTokens)}
          detail={`${formatCompactNumber(totals.inputTokens)} in · ${formatCompactNumber(totals.outputTokens)} out · ${tokenCoverage}% reported`}
        />
        <Metric
          label="Known model cost"
          value={formatUsd(totals.knownCostUsd)}
          detail={`${completeCoverage}% fully priced`}
        />
        <Metric
          label="Active agents"
          value={`${totals.activeAgents} / ${totals.agents}`}
          detail={`with activity in ${windowDescription(window)}`}
        />
        <Metric
          label="Open turns"
          value={formatCompactNumber(totals.activeTurns)}
          detail={`${totals.cancelledTurns} cancelled`}
        />
      </section>

      <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,0.8fr)]">
        <Panel title="Activity pulse" eyebrow={`Turns + tokens · ${windowDescription(window)}`}>
          <div
            data-testid="activity-chart"
            role="img"
            aria-label={`Turn and token activity over ${windowDescription(window)}`}
            className="px-2 pb-4 pt-4 sm:px-5"
          >
            <div className="flex items-center justify-end gap-4 px-2 text-[11px] text-surface-400">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 rounded-full bg-accent-400" />
                Reported tokens
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2 rounded-sm bg-amber-400/75" />
                Turns
              </span>
            </div>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="analyticsTokens" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2dd4bf" stopOpacity={0.42} />
                      <stop offset="100%" stopColor="#2dd4bf" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#3f3f46" strokeDasharray="3 5" vertical={false} opacity={0.45} />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#a1a1aa', fontSize: 11 }}
                    minTickGap={28}
                  />
                  <YAxis
                    yAxisId="tokens"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#a1a1aa', fontSize: 11 }}
                    tickFormatter={formatCompactNumber}
                    width={44}
                  />
                  <YAxis
                    yAxisId="turns"
                    orientation="right"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#a1a1aa', fontSize: 11 }}
                    allowDecimals={false}
                    width={30}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#18181b',
                      border: '1px solid #3f3f46',
                      borderRadius: 8,
                      color: '#f4f4f5',
                      fontSize: 12,
                    }}
                    cursor={{ fill: '#3f3f46', opacity: 0.18 }}
                  />
                  <Area
                    yAxisId="tokens"
                    type="monotone"
                    dataKey="totalTokens"
                    name="Reported tokens"
                    stroke="#2dd4bf"
                    strokeWidth={2}
                    fill="url(#analyticsTokens)"
                    activeDot={{ r: 4, fill: '#2dd4bf', stroke: '#0a0a0b' }}
                  />
                  <Bar
                    yAxisId="turns"
                    dataKey="turns"
                    name="Turns"
                    fill="#fbbf24"
                    opacity={0.72}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={12}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Panel>

        <Panel title="Telemetry integrity" eyebrow="Coverage + reconciliation">
          <div className="space-y-6 p-5">
            <div>
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-sm font-medium text-surface-200">Cost coverage</p>
                <p className="text-sm font-semibold tabular-nums text-surface-100">
                  {completeCoverage}%
                </p>
              </div>
              <p className="mt-1 text-xs text-surface-400">
                {totals.costCoverage.complete} of {totals.turns} turns fully priced
              </p>
              <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-700/70">
                {Object.entries(totals.costCoverage).map(([coverage, count]) => (
                  <span
                    key={coverage}
                    className={COVERAGE_TONES[coverage as keyof typeof COVERAGE_TONES]}
                    style={{ width: `${totals.turns === 0 ? 0 : (count / totals.turns) * 100}%` }}
                  />
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-surface-400">
                {Object.entries(totals.costCoverage).map(([coverage, count]) => (
                  <div key={coverage} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 capitalize">
                      <span className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        COVERAGE_TONES[coverage as keyof typeof COVERAGE_TONES],
                      )} />
                      {coverage}
                    </span>
                    <span className="tabular-nums text-surface-300">{count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-surface-700/60 pt-5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-medium text-surface-200">
                  {gateway?.state === 'healthy'
                    ? <CheckCircle2 className="h-4 w-4 text-accent-400" />
                    : <AlertTriangle className="h-4 w-4 text-amber-400" />}
                  {describeGatewayState(gateway)}
                </span>
                {gateway?.lagMs !== null && gateway?.lagMs !== undefined ? (
                  <span className="text-xs tabular-nums text-surface-400">
                    {Math.round(gateway.lagMs / 1000)}s behind
                  </span>
                ) : null}
              </div>
              {gateway?.lastError ? (
                <p className="mt-2 break-words text-xs text-rose-300">
                  {gateway.lastError}
                </p>
              ) : null}
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-surface-900/70 p-3">
                  <p className="text-label">Awaiting cost data</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-surface-200">
                    {gateway?.pendingCalls ?? '—'}
                  </p>
                </div>
                <div className="rounded-lg bg-surface-900/70 p-3">
                  <p className="text-label">No price configured</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-surface-200">
                    {gateway?.unpricedCalls ?? '—'}
                  </p>
                </div>
              </div>
              {gateway && gateway.orphanTransactions > 0 ? (
                <p className="mt-3 text-xs text-amber-300" title={quarantineBreakdownTitle(quarantine)}>
                  {gateway.orphanTransactions} gateway
                  {gateway.orphanTransactions === 1 ? ' charge' : ' charges'} couldn't be
                  matched to any run — totals may undercount
                  {describeQuarantineRecency(quarantine)}
                </p>
              ) : gateway && gateway.quarantinedTransactions > 0 ? (
                <p className="mt-3 text-xs text-surface-500" title={quarantineBreakdownTitle(quarantine)}>
                  {gateway.quarantinedTransactions} gateway
                  {gateway.quarantinedTransactions === 1 ? ' record' : ' records'} ignored — not
                  from agent runs{describeQuarantineRecency(quarantine)}
                </p>
              ) : null}
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,0.8fr)]">
        <Panel
          title="Agent activity"
          eyebrow={`Showing ${visibleAgents.length} of ${overview.agents.length} agents · ranked by reported tokens`}
        >
          <div className="divide-y divide-surface-700/60">
            {overview.agents.length === 0 ? (
              <p className="p-8 text-center text-sm text-surface-400">
                No agents are configured yet.
              </p>
            ) : visibleAgents.map((agent, index) => {
              const budget = budgetByAgent.get(agent.agentId);
              const activityValue = agent.totalTokens || agent.turns;
              const incompleteCostTurns = agent.costCoverage.partial
                + agent.costCoverage.pending
                + agent.costCoverage.unpriced;
              return (
                <Link
                  key={agent.agentId}
                  to={`/agents/${agent.agentId}`}
                  className="group relative block px-5 py-4 transition-colors hover:bg-surface-800/60"
                >
                  <div
                    className="absolute inset-y-0 left-0 bg-accent-500/[0.06] transition-colors group-hover:bg-accent-500/[0.09]"
                    style={{ width: `${Math.max(0, (activityValue / maxAgentActivity) * 100)}%` }}
                  />
                  <div className="relative grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-2 gap-y-3 sm:grid-cols-[32px_minmax(0,1.7fr)_repeat(3,minmax(72px,0.55fr))_24px] sm:gap-3">
                    <span className="row-span-2 self-start pt-0.5 font-mono text-xs tabular-nums text-surface-500 sm:row-span-1 sm:self-center sm:pt-0">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="line-clamp-2 break-all text-sm font-medium text-surface-100 sm:line-clamp-1 sm:break-normal">
                          {agent.name}
                        </p>
                        {budget ? (
                          <span
                            title={budget.state === 'ok'
                              ? 'Within all matching budget policies'
                              : `Tripped: ${[...new Set(
                                budget.matches
                                  .filter((match) => match.statuses.some((status) => status.state !== 'ok'))
                                  .map((match) => match.policyName),
                              )].join(', ') || 'budget policy'}`}
                            className={cn(
                              'shrink-0 max-w-[180px] truncate rounded-full border px-2 py-0.5 text-[10px] font-medium',
                              stateTone(budget.state),
                            )}
                          >
                            {budget.state === 'ok'
                              ? 'ok'
                              : `${budget.matches.find((match) =>
                                match.statuses.some((status) => status.state !== 'ok'))?.policyName
                                ?? 'budget'} · ${budget.state}`}
                          </span>
                        ) : null}
                        {incompleteCostTurns > 0 ? (
                          <button
                            type="button"
                            title={`${agent.costCoverage.pending} awaiting sync · ${agent.costCoverage.partial} partially priced · ${agent.costCoverage.unpriced} without a configured price — view these runs`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              navigate(`/agents/${agent.agentId}?tab=turns&filter=incomplete-cost`);
                            }}
                            className="shrink-0 rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-300 hover:bg-sky-500/20"
                          >
                            costs incomplete ({incompleteCostTurns})
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-1 truncate text-xs text-surface-400">
                        {agent.harness}
                        {agent.model ? ` · ${agent.model}` : ''}
                        {' · '}{formatRelativeTime(agent.lastActivityAt ?? undefined)}
                      </p>
                    </div>
                    <div className="col-start-2 grid grid-cols-3 gap-2 sm:contents">
                      <div>
                        <p className="text-label sm:text-right">Tokens</p>
                        <p className="mt-1 text-sm font-medium tabular-nums text-surface-200 sm:text-right">
                          {formatCompactNumber(agent.totalTokens)}
                        </p>
                      </div>
                      <div>
                        <p className="text-label sm:text-right">Turns</p>
                        <p className="mt-1 text-sm font-medium tabular-nums text-surface-200 sm:text-right">
                          {agent.turns}
                        </p>
                      </div>
                      <div>
                        <p className="text-label sm:text-right">Known cost</p>
                        <p className="mt-1 text-sm font-medium tabular-nums text-surface-200 sm:text-right">
                          {formatUsd(agent.knownCostUsd)}
                        </p>
                      </div>
                    </div>
                    <ArrowUpRight className="hidden h-4 w-4 text-surface-500 transition-colors group-hover:text-accent-400 sm:block" />
                  </div>
                </Link>
              );
            })}
          </div>
          {overview.agents.length > 20 ? (
            <button
              type="button"
              onClick={() => setShowAllAgents((current) => !current)}
              className="w-full border-t border-surface-700/60 px-5 py-3 text-xs font-medium text-accent-400 transition-colors hover:bg-surface-800/60 hover:text-accent-300"
            >
              {showAllAgents
                ? 'Show top 20 agents'
                : `Show all ${overview.agents.length} agents`}
            </button>
          ) : null}
        </Panel>

        <Panel
          title="Budget policies"
          eyebrow={policies
            ? `${policies.length} policies · ${enabledPolicies.length} enabled`
            : 'Policy status unavailable'}
        >
          <BudgetPolicyLedger
            policies={policies}
            statuses={budgetStatuses}
            refreshRevision={refreshRevision}
          />
        </Panel>
      </div>

      <footer className="mt-6 flex flex-col gap-1 border-t border-surface-700/60 pt-4 text-[11px] text-surface-500 sm:flex-row sm:items-center sm:justify-between">
        <p>Costs are known spend only; partial, pending, and unpriced turns remain visible.</p>
        <p className="tabular-nums">
          {updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : 'Not yet refreshed'}
        </p>
      </footer>
    </main>
  );
}
