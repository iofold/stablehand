import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2, Wallet } from 'lucide-react';
import type { ApiBudgetPolicy, ApiBudgetSpend } from '@ctxmill/shared';
import {
  createBudgetPolicy,
  deleteBudgetPolicy,
  fetchBudgetPolicies,
  fetchBudgetSpend,
  updateBudgetPolicy,
} from '@/lib/api';
import { formatCompactNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

const POLICY_TEMPLATE = {
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

function SpendMeter({ spend }: { spend: ApiBudgetSpend }) {
  return (
    <div className="space-y-3">
      {spend.buckets.length === 0 && (
        <p className="text-xs text-surface-400">No spend recorded in this window.</p>
      )}
      {spend.buckets.map((bucket) => (
        <div key={bucket.bucket ?? '__all__'} className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono text-surface-300">{bucket.bucket ?? 'all matching runs'}</span>
            <span className="text-surface-400 tabular-nums">
              {formatCompactNumber(bucket.spend.totalTokens)} tokens · {bucket.spend.turns} turns
              {bucket.spend.costUsd > 0 ? ` · $${bucket.spend.costUsd.toFixed(4)}` : ''}
            </span>
          </div>
          {bucket.statuses.map((status) => {
            const pct = Math.min(100, Math.round(status.ratio * 100));
            const over = status.ratio >= 1;
            const warn = !over && status.ratio >= 0.8;
            return (
              <div key={status.metric} className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-700/60">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      over ? 'bg-status-error' : warn ? 'bg-status-warning' : 'bg-accent-500',
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={cn(
                  'w-40 text-right text-[11px] tabular-nums',
                  over ? 'text-red-300' : warn ? 'text-amber-300' : 'text-surface-400',
                )}
                >
                  {formatCompactNumber(status.spent)} / {formatCompactNumber(status.limit)} {METRIC_LABELS[status.metric] ?? status.metric}
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
  initialDoc: Record<string, unknown>;
  submitLabel: string;
  onSubmit: (name: string, doc: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [docText, setDocText] = useState(JSON.stringify(initialDoc, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(docText) as Record<string, unknown>;
    } catch {
      setError('Policy doc is not valid JSON.');
      return;
    }
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), doc);
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
  const [policies, setPolicies] = useState<ApiBudgetPolicy[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [spendById, setSpendById] = useState<Record<string, ApiBudgetSpend | 'loading' | { error: string }>>({});

  const reload = useCallback(async () => {
    try {
      setPolicies(await fetchBudgetPolicies());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

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
    <div className="card p-0 lg:col-span-2" data-testid="budgets-section">
      <div className="flex items-center gap-3 border-b border-surface-700 px-5 py-4">
        <Wallet className="h-5 w-5 text-accent-400" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-surface-100">Budgets</h3>
          <p className="text-xs text-surface-400">
            Tag-based token/cost budgets. Runs count against every matching policy; new turns are
            blocked when any matching bucket is exhausted.
          </p>
        </div>
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
                    {JSON.stringify((policy.doc as { selector?: unknown }).selector ?? {})}
                    {(policy.doc as { groupBy?: string }).groupBy ? ` · by ${(policy.doc as { groupBy?: string }).groupBy}` : ''}
                    {' · '}{(policy.doc as { window?: string }).window}
                  </p>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-surface-400">
                  <input
                    type="checkbox"
                    checked={policy.enabled}
                    onChange={async (e) => {
                      await updateBudgetPolicy(policy.id, { enabled: e.target.checked });
                      await reload();
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
                    await deleteBudgetPolicy(policy.id);
                    await reload();
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
