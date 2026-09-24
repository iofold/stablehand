import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentBudgetStatus, BudgetPolicy, BudgetWindow } from '@stablehand/contracts';
import { fetchAgentBudgetStatuses, fetchBudgetPolicies } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatCompactNumber } from '@/lib/format';

const WINDOW_LABELS: Record<BudgetWindow, string> = {
  'rolling-1h': 'in the last hour',
  'rolling-24h': 'in the last 24 hours',
  'rolling-7d': 'in the last 7 days',
  'rolling-30d': 'in the last 30 days',
  'month-to-date': 'this month',
};

const METRIC_LABELS: Record<string, string> = {
  totalTokens: 'tokens',
  costUsd: '',
  turns: 'turns',
};

function formatAmount(metric: string, value: number): string {
  if (metric === 'costUsd') return `$${value.toFixed(2)}`;
  return formatCompactNumber(value);
}

function meterColor(state: 'ok' | 'warning' | 'blocked'): string {
  if (state === 'blocked') return 'bg-red-400';
  if (state === 'warning') return 'bg-amber-400';
  return 'bg-emerald-400';
}

function statePill(state: 'ok' | 'warning' | 'blocked') {
  const classes = state === 'blocked'
    ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : state === 'warning'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
  const label = state === 'blocked'
    ? 'over budget'
    : state === 'warning'
      ? 'nearing limit'
      : 'within budget';
  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', classes)}>
      {label}
    </span>
  );
}

export function AgentBudgetCard({ agentId }: { agentId: string }) {
  const [status, setStatus] = useState<AgentBudgetStatus | null>(null);
  const [policies, setPolicies] = useState<Map<string, BudgetPolicy>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);

    Promise.all([fetchAgentBudgetStatuses(), fetchBudgetPolicies()])
      .then(([statuses, policyList]) => {
        if (cancelled) return;
        setStatus(statuses.find((s) => s.agentId === agentId) ?? null);
        setPolicies(new Map<string, BudgetPolicy>(policyList.map((p) => [p.id, p])));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [agentId]);

  return (
    <div data-testid="agent-budget-card" className="rounded-lg border border-surface-700 bg-surface-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-label">Budget</h3>
        <Link
          to="/settings#budgets"
          className="text-xs font-medium text-accent-400 transition-colors hover:text-accent-300"
        >
          Manage budgets
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-surface-400">Loading budget status…</p>
      ) : loadError ? (
        <p className="text-sm text-surface-400">Budget status is unavailable right now.</p>
      ) : status == null || status.matches.length === 0 ? (
        <p className="text-sm text-surface-400">
          No budget policies apply to this agent. Turns run without spending limits.
        </p>
      ) : (
        <div className="space-y-4">
          {status.matches.map((match) => {
            const policy = policies.get(match.policyId);
            const windowLabel = policy ? WINDOW_LABELS[policy.doc.window] : '';
            const worst = match.statuses.some((s) => s.state === 'blocked')
              ? 'blocked'
              : match.statuses.some((s) => s.state === 'warning')
                ? 'warning'
                : 'ok';

            return (
              <div
                key={`${match.policyId}-${JSON.stringify(match.bucket)}`}
                data-testid="agent-budget-policy"
                className="rounded-lg border border-surface-700/50 bg-surface-900/40 p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-surface-200">{match.policyName}</span>
                  {match.bucket.kind === 'tag' && (
                    <span className="rounded-full border border-surface-600/50 bg-surface-800/70 px-2 py-0.5 font-mono text-[10px] text-surface-400">
                      {match.bucket.key}={match.bucket.value}
                    </span>
                  )}
                  {match.bucket.kind === 'untagged' && (
                    <span className="rounded-full border border-surface-600/50 bg-surface-800/70 px-2 py-0.5 text-[10px] text-surface-400">
                      runs without a {match.bucket.key} tag
                    </span>
                  )}
                  <span className="ml-auto">{statePill(worst)}</span>
                </div>

                {match.statuses.map((metricStatus) => {
                  const spent = metricStatus.spent ?? 0;
                  const ratio = metricStatus.ratio ?? (metricStatus.spent != null ? spent / metricStatus.limit : 0);
                  const unit = METRIC_LABELS[metricStatus.metric] ?? metricStatus.metric;
                  return (
                    <div key={metricStatus.metric} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-surface-300 tabular-nums">
                          {formatAmount(metricStatus.metric, spent)}
                          {unit ? ` ${unit}` : ''} of {formatAmount(metricStatus.metric, metricStatus.limit)}
                          {unit ? ` ${unit}` : ''} used {windowLabel}
                        </span>
                        <span className="text-[11px] text-surface-500 tabular-nums">
                          {Math.round(Math.min(1, ratio) * 100)}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-700/60">
                        <div
                          className={cn('h-full rounded-full transition-all', meterColor(metricStatus.state))}
                          style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
