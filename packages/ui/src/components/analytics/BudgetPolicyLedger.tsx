import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronDown,
  CircleDollarSign,
  Loader2,
  RotateCcw,
  Settings2,
} from 'lucide-react';
import type {
  AgentBudgetStatus,
  BudgetBucket,
  BudgetMetric,
  BudgetMetricStatus,
  BudgetPolicy,
  BudgetSpendResponse,
  BudgetWindow,
} from '@stablehand/contracts';

import { fetchBudgetSpend } from '@/lib/api';
import { formatCompactNumber, formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; spend: BudgetSpendResponse }
  | { state: 'error'; message: string };

interface PolicyRollup {
  state: 'ok' | 'warning' | 'blocked';
  maxRatio: number | null;
  agentIds: Set<string>;
}

const STATE_RANK = {
  ok: 0,
  warning: 1,
  blocked: 2,
} as const;

const WINDOW_LABELS: Record<BudgetWindow, string> = {
  'rolling-1h': 'Rolling hour',
  'rolling-24h': 'Rolling 24 hours',
  'rolling-7d': 'Rolling 7 days',
  'rolling-30d': 'Rolling 30 days',
  'month-to-date': 'Month to date (UTC)',
};

const METRIC_LABELS: Record<BudgetMetric, string> = {
  totalTokens: 'Tokens',
  costUsd: 'Known cost',
  turns: 'Turns',
};

function formatUsd(value: number): string {
  if (value > 0 && value < 0.0001) return `$${value.toPrecision(2)}`;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}`;
}

function formatMetricValue(metric: BudgetMetric, value: number): string {
  return metric === 'costUsd' ? formatUsd(value) : formatCompactNumber(value);
}

function bucketKey(bucket: BudgetBucket): string {
  if (bucket.kind === 'all') return 'all';
  if (bucket.kind === 'untagged') return `untagged:${bucket.key}`;
  return `tag:${bucket.key}:${bucket.value}`;
}

function bucketTitle(bucket: BudgetBucket): string {
  if (bucket.kind === 'all') return 'All matching turns';
  if (bucket.kind === 'untagged') return `Untagged ${bucket.key}`;
  return bucket.value;
}

function bucketDetail(bucket: BudgetBucket): string {
  if (bucket.kind === 'all') return 'One shared policy bucket';
  if (bucket.kind === 'untagged') return `${bucket.key} has no value`;
  return `${bucket.key} = ${bucket.value}`;
}

function stateClasses(state: 'ok' | 'warning' | 'blocked'): string {
  if (state === 'blocked') return 'border-rose-500/30 bg-rose-500/10 text-rose-300';
  if (state === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-accent-500/25 bg-accent-500/10 text-accent-300';
}

function stateLabel(state: 'ok' | 'warning' | 'blocked'): string {
  if (state === 'blocked') return 'Blocked';
  if (state === 'warning') return 'Warning';
  return 'Within limits';
}

function remainingLabel(status: BudgetMetricStatus): string {
  if (status.spent === null) return 'Remaining unknown';
  const delta = status.limit - status.spent;
  if (delta < 0) {
    return `${formatMetricValue(status.metric, Math.abs(delta))} over limit`;
  }
  return `${formatMetricValue(status.metric, delta)} remaining`;
}

function MetricLedger({ status }: { status: BudgetMetricStatus }) {
  const percentage = status.ratio === null ? null : Math.round(status.ratio * 100);
  return (
    <div className="border-t border-surface-700/50 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-surface-200">
            {METRIC_LABELS[status.metric]}
          </p>
          <p className="mt-0.5 text-[11px] text-surface-500">
            {remainingLabel(status)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold tabular-nums text-surface-100">
            {status.spent === null
              ? 'No usage data yet'
              : `${formatMetricValue(status.metric, status.spent)} of ${formatMetricValue(status.metric, status.limit)}`}
          </p>
          <p className={cn(
            'mt-0.5 text-[11px] font-medium tabular-nums',
            status.state === 'blocked'
              ? 'text-rose-300'
              : status.state === 'warning'
                ? 'text-amber-300'
                : 'text-surface-400',
          )}>
            {percentage === null
              ? 'treated as within budget'
              : `${percentage}% used`}
            {status.action
              ? ` · ${status.action.action === 'block' ? 'blocks' : 'warns'} at ${Math.round(status.action.threshold * 100)}%`
              : ''}
          </p>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={`${METRIC_LABELS[status.metric]} utilization`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage === null ? undefined : Math.min(100, percentage)}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-700/70"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            status.state === 'blocked'
              ? 'bg-rose-400'
              : status.state === 'warning'
                ? 'bg-amber-400'
                : 'bg-accent-400',
          )}
          style={{ width: `${Math.min(100, percentage ?? 0)}%` }}
        />
      </div>
    </div>
  );
}

function SpendLedger({ spend }: { spend: BudgetSpendResponse }) {
  if (spend.buckets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-surface-700 px-4 py-5 text-center">
        <p className="text-sm text-surface-300">No matching turns in this policy window.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {spend.buckets.map((bucket) => (
        <section
          key={bucketKey(bucket.bucket)}
          className="overflow-hidden rounded-lg border border-surface-700/70 bg-surface-900/50"
        >
          <div className="border-b border-surface-700/50 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-medium text-surface-200">
                  {bucketTitle(bucket.bucket)}
                </h4>
                <p className="mt-0.5 truncate font-mono text-[10px] text-surface-500">
                  {bucketDetail(bucket.bucket)}
                </p>
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-surface-400">
                {bucket.spend.turns} {bucket.spend.turns === 1 ? 'turn' : 'turns'}
              </span>
            </div>
            <div className="mt-2 grid gap-1 text-[10px] leading-4 text-surface-500 sm:grid-cols-2">
              <span>
                Tokens reported for {bucket.spend.tokenReportedTurnCount} of {bucket.spend.turns} turns
              </span>
              <span>
                Cost reported for {bucket.spend.costReportedTurnCount} of {bucket.spend.turns} turns
              </span>
            </div>
          </div>
          <div className="px-4">
            {bucket.statuses.map((status) => (
              <MetricLedger key={status.metric} status={status} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Definition({ policy }: { policy: BudgetPolicy }) {
  const selectors = Object.entries(policy.doc.selector);
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-label">Policy definition</h3>
        <Link
          to="/settings#budgets"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-accent-400 hover:text-accent-300"
        >
          <Settings2 className="h-3 w-3" />
          Edit in settings
        </Link>
      </div>
      <dl className="mt-3 grid gap-x-4 gap-y-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-surface-500">Scope</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5 text-surface-200">
            {selectors.length === 0
              ? <span>All tagged turns</span>
              : selectors.map(([key, value]) => (
                <span
                  key={key}
                  className="max-w-full rounded border border-surface-700 bg-surface-900/70 px-1.5 py-0.5 font-mono text-[10px] [overflow-wrap:anywhere]"
                >
                  {key} = {value}
                </span>
              ))}
          </dd>
        </div>
        <div>
          <dt className="text-surface-500">Buckets</dt>
          <dd className="mt-1 text-surface-200">
            {policy.doc.groupBy ? `Group by ${policy.doc.groupBy}` : 'One shared bucket'}
          </dd>
        </div>
        <div>
          <dt className="text-surface-500">Window</dt>
          <dd className="mt-1 text-surface-200">{WINDOW_LABELS[policy.doc.window]}</dd>
        </div>
        <div>
          <dt className="text-surface-500">Actions</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {policy.doc.actions.map((action) => (
              <span
                key={action.action}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px] font-medium',
                  action.action === 'block'
                    ? 'border-rose-500/25 bg-rose-500/10 text-rose-300'
                    : 'border-amber-500/25 bg-amber-500/10 text-amber-300',
                )}
              >
                {action.action === 'block' ? 'Block' : 'Warn'} at {Math.round(action.threshold * 100)}%
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-surface-500">Limits</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5 text-surface-200">
            {Object.entries(policy.doc.limits).map(([metric, value]) => (
              <span key={metric}>
                {METRIC_LABELS[metric as BudgetMetric]} {formatMetricValue(metric as BudgetMetric, value)}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-surface-500">Last changed</dt>
          <dd className="mt-1 text-surface-200">{formatTimestamp(policy.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

function buildRollups(statuses: AgentBudgetStatus[] | null): Map<string, PolicyRollup> {
  const rollups = new Map<string, PolicyRollup>();
  for (const agent of statuses ?? []) {
    for (const match of agent.matches) {
      const current = rollups.get(match.policyId) ?? {
        state: 'ok',
        maxRatio: null,
        agentIds: new Set<string>(),
      };
      current.agentIds.add(agent.agentId);
      for (const status of match.statuses) {
        if (STATE_RANK[status.state] > STATE_RANK[current.state]) {
          current.state = status.state;
        }
        if (status.ratio !== null) {
          current.maxRatio = Math.max(current.maxRatio ?? 0, status.ratio);
        }
      }
      rollups.set(match.policyId, current);
    }
  }
  return rollups;
}

export function BudgetPolicyLedger({
  policies,
  statuses,
  refreshRevision,
}: {
  policies: BudgetPolicy[] | null;
  statuses: AgentBudgetStatus[] | null;
  refreshRevision: number;
}) {
  const [expandedPolicyId, setExpandedPolicyId] = useState<string | null>(null);
  const [loads, setLoads] = useState<Record<string, LoadState>>({});
  const requestVersions = useRef<Record<string, number>>({});
  const rollups = useMemo(() => buildRollups(statuses), [statuses]);
  const warningAgents = statuses?.filter((status) => status.state === 'warning').length ?? 0;
  const blockedAgents = statuses?.filter((status) => status.state === 'blocked').length ?? 0;

  useEffect(() => {
    requestVersions.current = {};
    setExpandedPolicyId(null);
    setLoads({});
  }, [refreshRevision]);

  const loadSpend = useCallback(async (policyId: string, force = false) => {
    const existing = loads[policyId];
    if (!force && (existing?.state === 'loading' || existing?.state === 'ready')) return;

    const version = (requestVersions.current[policyId] ?? 0) + 1;
    requestVersions.current[policyId] = version;
    setLoads((current) => ({ ...current, [policyId]: { state: 'loading' } }));
    try {
      const spend = await fetchBudgetSpend(policyId);
      if (requestVersions.current[policyId] !== version) return;
      setLoads((current) => ({ ...current, [policyId]: { state: 'ready', spend } }));
    } catch (error) {
      if (requestVersions.current[policyId] !== version) return;
      setLoads((current) => ({
        ...current,
        [policyId]: {
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, [loads]);

  const togglePolicy = (policyId: string) => {
    if (expandedPolicyId === policyId) {
      setExpandedPolicyId(null);
      return;
    }
    setExpandedPolicyId(policyId);
    void loadSpend(policyId);
  };

  if (policies === null) {
    return (
      <div className="p-5 text-xs text-amber-300">
        Budget policies are unavailable.
      </div>
    );
  }

  if (policies.length === 0) {
    return (
      <div className="m-5 rounded-lg border border-dashed border-surface-700 p-5 text-center">
        <CircleDollarSign className="mx-auto h-5 w-5 text-surface-500" />
        <p className="mt-2 text-sm text-surface-300">No budget policies</p>
        <Link to="/settings#budgets" className="mt-2 inline-block text-xs text-accent-400 hover:text-accent-300">
          Add a budget policy
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 p-5 pb-4">
        <div className="rounded-lg border border-surface-700/60 bg-surface-900/60 p-3">
          <p className="text-label">Warning agents</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-amber-300">
            {statuses ? warningAgents : '—'}
          </p>
        </div>
        <div className="rounded-lg border border-surface-700/60 bg-surface-900/60 p-3">
          <p className="text-label">Blocked agents</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-rose-300">
            {statuses ? blockedAgents : '—'}
          </p>
        </div>
      </div>
      <p className="px-5 pb-3 text-[10px] leading-4 text-surface-500">
        Usage is measured over each policy&apos;s own window.
      </p>
      <div className="divide-y divide-surface-700/60 border-t border-surface-700/60">
        {policies.map((policy) => {
          const expanded = expandedPolicyId === policy.id;
          const load = loads[policy.id];
          const rollup = rollups.get(policy.id);
          const percentage = rollup?.maxRatio === null || rollup?.maxRatio === undefined
            ? null
            : Math.round(rollup.maxRatio * 100);
          const detailsId = `policy-details-${policy.id}`;

          return (
            <div key={policy.id}>
              <button
                type="button"
                data-policy-row={policy.id}
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => togglePolicy(policy.id)}
                className={cn(
                  'group flex w-full items-center gap-3 px-5 py-3.5 text-left outline-none transition-colors',
                  'hover:bg-surface-800/65 focus-visible:bg-surface-800/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500/60',
                  expanded && 'bg-surface-800/55',
                )}
              >
                <ChevronDown className={cn(
                  'h-4 w-4 shrink-0 text-surface-500 transition-transform group-hover:text-surface-300',
                  !expanded && '-rotate-90',
                )} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-surface-200">
                      {policy.name}
                    </span>
                    {!policy.enabled ? (
                      <span className="rounded border border-surface-600 bg-surface-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-surface-400">
                        Disabled
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-surface-500">
                    {WINDOW_LABELS[policy.doc.window]}
                    {policy.doc.groupBy ? ` · group by ${policy.doc.groupBy}` : ' · shared bucket'}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  {policy.enabled && rollup ? (
                    <>
                      <span className={cn(
                        'inline-flex rounded border px-1.5 py-0.5 text-[9px] font-medium',
                        stateClasses(rollup.state),
                      )}>
                        {stateLabel(rollup.state)}
                      </span>
                      <span className="mt-1 block text-[10px] tabular-nums text-surface-400">
                        {percentage === null ? 'Usage not reported' : `${percentage}% highest`}
                        {' · '}{rollup.agentIds.size} {rollup.agentIds.size === 1 ? 'agent' : 'agents'}
                      </span>
                    </>
                  ) : (
                    <span className="text-[10px] text-surface-500">
                      {policy.enabled ? 'No matched agents' : 'Not enforced'}
                    </span>
                  )}
                </span>
              </button>

              {expanded ? (
                <div
                  id={detailsId}
                  role="region"
                  aria-label={`${policy.name} policy details`}
                  className="border-t border-surface-700/50 bg-surface-900/35 px-5 py-5"
                >
                  <Definition policy={policy} />
                  <div className="mt-5 border-t border-surface-700/60 pt-4">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-label">Usage ledger</h3>
                        {load?.state === 'ready' ? (
                          <p className="mt-1 text-[10px] text-surface-500">
                            Since {formatTimestamp(load.spend.windowStart)}
                          </p>
                        ) : null}
                      </div>
                      {load?.state === 'ready' ? (
                        <span className="text-[10px] text-surface-500">
                          {load.spend.buckets.length} {load.spend.buckets.length === 1 ? 'bucket' : 'buckets'}
                        </span>
                      ) : null}
                    </div>

                    {load?.state === 'loading' || !load ? (
                      <div className="flex items-center gap-2 rounded-lg border border-surface-700/60 px-4 py-4 text-xs text-surface-400">
                        <Loader2 className="h-4 w-4 animate-spin text-accent-400" />
                        Loading policy usage…
                      </div>
                    ) : null}

                    {load?.state === 'error' ? (
                      <div role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-4">
                        <div className="flex items-start gap-2 text-xs text-rose-200">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <p>Policy usage could not be loaded: {load.message}</p>
                        </div>
                        <button
                          type="button"
                          data-policy-spend-retry={policy.id}
                          onClick={() => void loadSpend(policy.id, true)}
                          className="btn-secondary mt-3 px-2.5 py-1.5 text-[11px]"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Retry usage
                        </button>
                      </div>
                    ) : null}

                    {load?.state === 'ready' ? <SpendLedger spend={load.spend} /> : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
