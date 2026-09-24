import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, Plus, Trash2, Wallet } from 'lucide-react';
import {
  BudgetPolicyDocSchema,
  type BudgetBucket,
  type BudgetPolicy,
  type BudgetPolicyDoc,
  type BudgetSpendResponse,
  type ModelGatewayStatus,
} from '@stablehand/contracts';
import {
  createBudgetPolicy,
  deleteBudgetPolicy,
  fetchBudgetPolicies,
  fetchBudgetSpend,
  fetchModelGatewayStatus,
  updateBudgetPolicy,
} from '@/lib/api';
import { formatCompactNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { RelativeTime } from '@/components/ui/RelativeTime';

const POLICY_TEMPLATE: BudgetPolicyDoc = {
  selector: { bu: 'finance' },
  groupBy: 'user',
  window: 'rolling-24h',
  limits: { totalTokens: 200000 },
  actions: [
    { threshold: 0.8, action: 'warn' },
    { threshold: 1, action: 'block' },
  ],
};

const METRIC_LABELS: Record<string, string> = {
  totalTokens: 'tokens',
  costUsd: 'USD',
  turns: 'turns',
};

function formatMetricValue(metric: string, value: number): string {
  if (metric !== 'costUsd') return formatCompactNumber(value);
  if (value > 0 && value < 0.0001) return value.toPrecision(2);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

function bucketLabel(bucket: BudgetBucket): string {
  if (bucket.kind === 'all') return 'all matching runs';
  if (bucket.kind === 'untagged') return `${bucket.key}: untagged`;
  return `${bucket.key}=${bucket.value}`;
}

function bucketKey(bucket: BudgetBucket): string {
  if (bucket.kind === 'all') return 'all';
  if (bucket.kind === 'untagged') return `untagged:${bucket.key}`;
  return `tag:${bucket.key}:${bucket.value}`;
}

function SpendMeter({ spend }: { spend: BudgetSpendResponse }) {
  return (
    <div className="space-y-3">
      {spend.buckets.length === 0 && (
        <p className="text-xs text-surface-400">No spend recorded in this window.</p>
      )}
      {spend.buckets.map((bucket) => (
        <div key={bucketKey(bucket.bucket)} className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono text-surface-300">{bucketLabel(bucket.bucket)}</span>
            <span className="text-surface-400 tabular-nums">
              {bucket.spend.totalTokens === null
                ? 'Tokens not reported'
                : `${formatCompactNumber(bucket.spend.totalTokens)} tokens`}
              {' · '}{bucket.spend.turns} turns
              {bucket.spend.tokenReportedTurnCount < bucket.spend.turns
                ? ` · tokens ${bucket.spend.tokenReportedTurnCount}/${bucket.spend.turns} reported`
                : ''}
              {' · '}{bucket.spend.costUsd === null
                ? 'Cost not reported'
                : `$${bucket.spend.costUsd.toFixed(4)}`}
              {bucket.spend.costReportedTurnCount < bucket.spend.turns
                ? ` (${bucket.spend.costReportedTurnCount}/${bucket.spend.turns} turns)`
                : ''}
            </span>
          </div>
          {bucket.statuses.map((status) => {
            const pct = status.ratio === null
              ? 0
              : Math.min(100, Math.round(status.ratio * 100));
            const blocked = status.state === 'blocked';
            const warning = status.state === 'warning';
            return (
              <div key={status.metric} className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-700/60">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      blocked
                        ? 'bg-status-error'
                        : warning
                          ? 'bg-status-warning'
                          : 'bg-accent-500',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={cn(
                  'w-40 text-right text-[11px] tabular-nums',
                  blocked
                    ? 'text-red-300'
                    : warning
                      ? 'text-amber-300'
                      : 'text-surface-400',
                )}
                >
                  {status.spent === null
                    ? 'No usage data'
                    : formatMetricValue(status.metric, status.spent)}
                  {' / '}{formatMetricValue(status.metric, status.limit)} {METRIC_LABELS[status.metric] ?? status.metric}
                  {status.action
                    ? ` · ${status.action.action === 'block' ? 'blocks' : 'warns'} at ${Math.round(status.action.threshold * 100)}%`
                    : ''}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PolicyEditor({
  initialName,
  initialDoc,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialDoc: BudgetPolicyDoc;
  submitLabel: string;
  onSubmit: (name: string, doc: BudgetPolicyDoc) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [docText, setDocText] = useState(JSON.stringify(initialDoc, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    let rawDoc: unknown;
    try {
      rawDoc = JSON.parse(docText) as unknown;
    } catch {
      setError('Policy doc is not valid JSON.');
      return;
    }
    const parsed = BudgetPolicyDocSchema.safeParse(rawDoc);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      setError(`Invalid policy: ${path}${issue?.message ?? 'invalid document'}`);
      return;
    }
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3 rounded-lg border border-surface-700/60 bg-surface-900/40 p-4">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Policy name (e.g. per-user daily cap)"
        className="w-full rounded-lg border border-surface-600/40 bg-surface-800/60 px-3 py-1.5 text-sm text-surface-200 focus:outline-none focus:border-accent-500/50"
      />
      <textarea
        value={docText}
        onChange={(e) => setDocText(e.target.value)}
        rows={12}
        spellCheck={false}
        className="w-full rounded-lg border border-surface-600/40 bg-surface-900 px-3 py-2 font-mono text-xs text-surface-200 focus:outline-none focus:border-accent-500/50"
      />
      <p className="text-[11px] text-surface-400">
        selector: tag map runs must contain · groupBy: one bucket per value of this tag
        (values must be provisioned in agent metadata.budgetDimensions) · window: rolling-1h/24h/7d/30d
        or month-to-date (UTC) · limits: totalTokens, costUsd, turns · actions: warn/block at threshold.
      </p>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void handleSubmit()} disabled={busy} className="btn-primary text-xs px-3 py-1.5">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary text-xs px-3 py-1.5">Cancel</button>
      </div>
    </div>
  );
}

export function BudgetsSection() {
  const [policies, setPolicies] = useState<BudgetPolicy[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [spendById, setSpendById] = useState<Record<string, BudgetSpendResponse | 'loading' | { error: string }>>({});
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [modelGatewayStatus, setModelGatewayStatus] =
    useState<ModelGatewayStatus | null>(null);

  const reload = useCallback(async () => {
    try {
      setPolicies(await fetchBudgetPolicies());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    let cancelled = false;
    const refreshGateway = async () => {
      try {
        const status = await fetchModelGatewayStatus();
        if (!cancelled) setModelGatewayStatus(status);
      } catch {
        if (!cancelled) setModelGatewayStatus(null);
      }
    };
    void refreshGateway();
    const timer = setInterval(() => {
      void refreshGateway();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reload]);

  const loadSpend = useCallback(async (id: string) => {
    setSpendById((prev) => ({ ...prev, [id]: 'loading' }));
    try {
      const spend = await fetchBudgetSpend(id);
      setSpendById((prev) => ({ ...prev, [id]: spend }));
    } catch (err) {
      setSpendById((prev) => ({ ...prev, [id]: { error: err instanceof Error ? err.message : String(err) } }));
    }
  }, []);

  const handleExpand = (id: string) => {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    if (next) void loadSpend(next);
  };

  return (
    <div id="budgets" className="card scroll-mt-6 p-0 lg:col-span-2" data-testid="budgets-section">
      <div className="flex items-center gap-3 border-b border-surface-700 px-5 py-4">
        <Wallet className="h-5 w-5 text-accent-400" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-surface-100">Budgets</h3>
          <p className="text-xs text-surface-400">
            Tag-based token/cost budgets. Runs count against every matching policy; new turns are
            blocked when any matching bucket is exhausted.
          </p>
        </div>
        {modelGatewayStatus && (
          <span
            data-testid="model-gateway-status"
            title={modelGatewayStatus.lastError ?? undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
              modelGatewayStatus.state === 'healthy'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : modelGatewayStatus.state === 'degraded'
                  ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                  : 'border-surface-600 bg-surface-700/30 text-surface-300',
            )}
          >
            {modelGatewayStatus.state === 'healthy'
              ? <CheckCircle2 className="h-3.5 w-3.5" />
              : modelGatewayStatus.state === 'degraded'
                ? <AlertTriangle className="h-3.5 w-3.5" />
                : null}
            {modelGatewayStatus.state === 'disabled'
              ? 'Direct metering'
              : modelGatewayStatus.state === 'initializing'
                ? 'Cost sync starting'
                : modelGatewayStatus.state === 'degraded'
                  ? 'Cost sync degraded'
                  : (
                    <>
                      Cost synced
                      {modelGatewayStatus.lastSuccessAt !== null && (
                        <> <RelativeTime timestamp={modelGatewayStatus.lastSuccessAt} /></>
                      )}
                    </>
                  )}
          </span>
        )}
        <button
          type="button"
          onClick={() => { setCreating((v) => !v); setEditingId(null); }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-surface-700 px-3 py-1.5 text-xs font-medium text-surface-100 hover:bg-surface-600 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New Policy
        </button>
      </div>

      <div className="divide-y divide-surface-700/50">
        {mutationError && (
          <div role="alert" className="px-5 py-3 text-sm text-red-300">
            Budget policy update failed: {mutationError}
          </div>
        )}
        {creating && (
          <div className="px-5 py-4">
            <PolicyEditor
              initialName=""
              initialDoc={POLICY_TEMPLATE}
              submitLabel="Create policy"
              onCancel={() => setCreating(false)}
              onSubmit={async (name, doc) => {
                await createBudgetPolicy({ name, doc });
                setCreating(false);
                await reload();
              }}
            />
          </div>
        )}

        {policies === null && !loadError && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 text-accent-400 animate-spin" />
          </div>
        )}
        {loadError && (
          <div className="px-5 py-4 text-sm text-red-400">Failed to load budget policies: {loadError}</div>
        )}
        {policies?.length === 0 && !creating && (
          <div className="px-5 py-6 text-center text-sm text-surface-400">
            No budget policies yet. Create one to start metering token spend by user, business unit, or any tag.
          </div>
        )}

        {policies?.map((policy) => {
          const spend = spendById[policy.id];
          const isExpanded = expandedId === policy.id;
          return (
            <div key={policy.id}>
              <div className="flex items-center gap-3 px-5 py-3">
                <button
                  type="button"
                  onClick={() => handleExpand(policy.id)}
                  aria-label={`Toggle spend for ${policy.name}`}
                  className="text-surface-400 hover:text-surface-200"
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-surface-200 truncate">{policy.name}</p>
                  <p className="text-[11px] font-mono text-surface-400 truncate">
                    {JSON.stringify(policy.doc.selector)}
                    {policy.doc.groupBy ? ` · by ${policy.doc.groupBy}` : ''}
                    {' · '}{policy.doc.window}
                  </p>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-surface-400">
                  <input
                    type="checkbox"
                    checked={policy.enabled}
                    onChange={async (e) => {
                      setMutationError(null);
                      try {
                        await updateBudgetPolicy(policy.id, { enabled: e.target.checked });
                        await reload();
                      } catch (err) {
                        setMutationError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  />
                  Enabled
                </label>
                <button
                  type="button"
                  onClick={() => { setEditingId(editingId === policy.id ? null : policy.id); setCreating(false); }}
                  className="text-xs text-accent-400 hover:text-accent-300"
                >
                  Edit
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${policy.name}`}
                  onClick={async () => {
                    if (!window.confirm(`Delete budget policy "${policy.name}"?`)) return;
                    setMutationError(null);
                    try {
                      await deleteBudgetPolicy(policy.id);
                      await reload();
                    } catch (err) {
                      setMutationError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  className="text-surface-400 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {editingId === policy.id && (
                <div className="px-5 pb-4">
                  <PolicyEditor
                    initialName={policy.name}
                    initialDoc={policy.doc}
                    submitLabel="Save policy"
                    onCancel={() => setEditingId(null)}
                    onSubmit={async (name, doc) => {
                      await updateBudgetPolicy(policy.id, { name, doc });
                      setEditingId(null);
                      await reload();
                    }}
                  />
                </div>
              )}

              {isExpanded && (
                <div className="px-5 pb-4 pl-12">
                  {spend === 'loading' && <Loader2 className="h-4 w-4 text-accent-400 animate-spin" />}
                  {spend && spend !== 'loading' && 'error' in spend && (
                    <p className="text-xs text-red-300">Failed to load spend: {spend.error}</p>
                  )}
                  {spend && spend !== 'loading' && !('error' in spend) && <SpendMeter spend={spend} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
