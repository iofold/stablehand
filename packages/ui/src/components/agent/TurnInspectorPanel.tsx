import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Copy, Check, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { formatSpendUsd, type AgentBudgetStatus, type Turn } from '@stablehand/contracts';
import { fetchTurnDetail, fetchAgentBudgetStatuses } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatDurationBetween, formatCompactNumber } from '@/lib/format';
import { describeTurnCost } from '@/lib/usage-cost';
import { TurnStatusBadge } from './TurnStatusBadge';
import { ErrorDisplay } from '@/components/session/ErrorDisplay';
import { BudgetStopBanner } from '@/components/session/BudgetStopBanner';

export interface TurnInspectorPanelProps {
  agentId: string;
  turnId: string;
  onClose: () => void;
}

function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-surface-400 flex-shrink-0">{label}</span>
      <span className="text-xs text-surface-200 tabular-nums text-right min-w-0">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-label">{title}</h4>
      {children}
    </div>
  );
}

function CopyableId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      console.debug('[TurnInspector] Clipboard write failed');
    }
  }, [value]);

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-surface-400 flex-shrink-0">{label}</span>
      <button
        type="button"
        onClick={handleCopy}
        title={`Copy ${value}`}
        className="group flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 font-mono text-[11px] text-surface-300 transition-colors hover:bg-surface-800 hover:text-surface-100"
      >
        <span className="truncate">{value}</span>
        {copied ? (
          <Check className="h-3 w-3 flex-shrink-0 text-emerald-400" />
        ) : (
          <Copy className="h-3 w-3 flex-shrink-0 text-surface-500 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>
    </div>
  );
}

function budgetStateClasses(state: 'ok' | 'warning' | 'blocked'): string {
  if (state === 'blocked') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (state === 'warning') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
}

const BUDGET_METRIC_LABELS: Record<string, string> = {
  totalTokens: 'tokens',
  costUsd: 'spend',
  turns: 'turns',
};

function formatBudgetAmount(metric: string, value: number): string {
  if (metric === 'costUsd') return `$${value.toFixed(2)}`;
  return formatCompactNumber(value);
}

export function TurnInspectorPanel({ agentId, turnId, onClose }: TurnInspectorPanelProps) {
  const [turn, setTurn] = useState<Turn | null>(null);
  const [messageCount, setMessageCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [budgetStatus, setBudgetStatus] = useState<AgentBudgetStatus | null>(null);
  const [budgetUnavailable, setBudgetUnavailable] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTurn(null);
    setLoadError(null);

    fetchTurnDetail(agentId, turnId)
      .then((detail) => {
        if (cancelled) return;
        setTurn(detail.turn);
        setMessageCount(detail.messages.length);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => { cancelled = true; };
  }, [agentId, turnId]);

  useEffect(() => {
    let cancelled = false;
    fetchAgentBudgetStatuses()
      .then((statuses) => {
        if (cancelled) return;
        setBudgetStatus(statuses.find((status) => status.agentId === agentId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setBudgetUnavailable(true);
      });
    return () => { cancelled = true; };
  }, [agentId]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const cost = turn ? describeTurnCost(turn.usage) : null;
  const tags = Object.entries(turn?.tags ?? {});

  return (
    <div
      data-testid="turn-inspector"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[400px] flex-col border-l border-surface-700 bg-surface-900 shadow-2xl animate-fade-in"
    >
      <div className="flex items-center justify-between border-b border-surface-800 p-4">
        <div className="flex items-center gap-2.5">
          <h3 className="font-medium text-surface-100">Turn details</h3>
          {turn && (
            <TurnStatusBadge
              status={turn.status}
              sandboxStatus={turn.sandboxStatus}
              lastRestoreError={turn.lastRestoreError}
            />
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close turn details"
          className="rounded p-1 text-surface-400 transition-colors hover:text-surface-100"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        {loadError ? (
          <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            Could not load this turn: {loadError}
          </div>
        ) : !turn ? (
          <div className="flex justify-center py-10">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-surface-600 border-t-accent-400" />
          </div>
        ) : (
          <>
            {turn.taskDescription && (
              <p className="rounded border border-surface-700/30 bg-surface-800/60 px-2.5 py-1.5 text-sm text-surface-300">
                {turn.taskDescription}
              </p>
            )}

            {turn.stopReason ? (
              <BudgetStopBanner reason={turn.stopReason} />
            ) : turn.error && (
              <ErrorDisplay summary="This turn failed" details={turn.error} />
            )}

            <Section title="Timing">
              <div className="space-y-1.5">
                <DetailRow label="Started">{formatAbsoluteTime(turn.startedAt)}</DetailRow>
                {turn.completedAt != null ? (
                  <>
                    <DetailRow label="Finished">{formatAbsoluteTime(turn.completedAt)}</DetailRow>
                    <DetailRow label="Ran for">{formatDurationBetween(turn.startedAt, turn.completedAt)}</DetailRow>
                  </>
                ) : (
                  <DetailRow label="Finished">Still running</DetailRow>
                )}
                {turn.usageReconciledAt != null && (
                  <DetailRow label="Cost data synced">{formatAbsoluteTime(turn.usageReconciledAt)}</DetailRow>
                )}
                {turn.checkpointAt != null && (
                  <DetailRow label="Checkpointed">{formatAbsoluteTime(turn.checkpointAt)}</DetailRow>
                )}
                {(turn.restoreAttempts ?? 0) > 0 && (
                  <DetailRow label="Restore attempts">{turn.restoreAttempts}</DetailRow>
                )}
              </div>
            </Section>

            <Section title="Cost & tokens">
              <div className="space-y-1.5">
                <DetailRow label="Model cost">
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[11px]',
                      cost!.state === 'complete'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : cost!.state === 'pending'
                          ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                          : cost!.state === 'partial'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            : 'border-surface-600 bg-surface-700/30 text-surface-400',
                    )}
                    title={cost!.title}
                  >
                    {cost!.label}
                  </span>
                </DetailRow>
                {turn.stopReason?.code === 'budget_reached' && (
                  <>
                    <DetailRow label="Spend cap">
                      {formatSpendUsd(turn.stopReason.capUsd)}{' '}
                      <span className="text-surface-500">
                        {turn.stopReason.source === 'run_limit'
                          ? '(per-run limit)'
                          : `(left in ${turn.stopReason.policyName ? `"${turn.stopReason.policyName}"` : 'budget'})`}
                      </span>
                    </DetailRow>
                    <DetailRow label="Spent when stopped">
                      {turn.stopReason.spentUsd != null ? formatSpendUsd(turn.stopReason.spentUsd) : 'Not reported'}
                    </DetailRow>
                  </>
                )}
                {turn.usage && (
                  <>
                    <DetailRow label="Tokens">
                      {turn.usage.inputTokens.toLocaleString()} in · {turn.usage.outputTokens.toLocaleString()} out
                    </DetailRow>
                    {turn.usage.modelCalls.observed > 0 && (
                      <DetailRow label="Model calls priced">
                        {turn.usage.modelCalls.costKnown} of {turn.usage.modelCalls.observed}
                      </DetailRow>
                    )}
                  </>
                )}
              </div>
            </Section>

            <Section title="Budget">
              {budgetUnavailable ? (
                <p className="text-xs text-surface-500">Budget status didn't load.</p>
              ) : budgetStatus == null || budgetStatus.matches.length === 0 ? (
                <p className="text-xs text-surface-500">
                  No budget policies apply to this agent.{' '}
                  <Link to="/settings#budgets" className="text-accent-400 hover:text-accent-300">
                    Manage budgets
                  </Link>
                </p>
              ) : (
                <div className="space-y-2">
                  {budgetStatus.matches.map((match) => (
                    <div
                      key={`${match.policyId}-${JSON.stringify(match.bucket)}`}
                      className="rounded-lg border border-surface-700/50 bg-surface-800/40 px-2.5 py-2 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium text-surface-200">{match.policyName}</span>
                        {(() => {
                          const worst = match.statuses.some((s) => s.state === 'blocked')
                            ? 'blocked'
                            : match.statuses.some((s) => s.state === 'warning')
                              ? 'warning'
                              : 'ok';
                          return (
                            <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', budgetStateClasses(worst))}>
                              {worst === 'ok' ? 'within budget' : worst}
                            </span>
                          );
                        })()}
                      </div>
                      {match.statuses.map((status) => (
                        <p key={status.metric} className="text-[11px] text-surface-400 tabular-nums">
                          {status.spent != null
                            ? `${formatBudgetAmount(status.metric, status.spent)} of ${formatBudgetAmount(status.metric, status.limit)} ${BUDGET_METRIC_LABELS[status.metric] ?? status.metric} used`
                            : `No ${BUDGET_METRIC_LABELS[status.metric] ?? status.metric} recorded yet (limit ${formatBudgetAmount(status.metric, status.limit)})`}
                        </p>
                      ))}
                    </div>
                  ))}
                  <p className="text-[10px] text-surface-500">
                    Current budget use, not the use at the time of this turn.
                  </p>
                </div>
              )}
            </Section>

            {tags.length > 0 && (
              <Section title="Tags">
                <div className="flex flex-wrap gap-1.5">
                  {tags.map(([key, value]) => (
                    <span
                      key={key}
                      className="rounded-full border border-surface-600/50 bg-surface-800/70 px-2 py-0.5 font-mono text-[10px] text-surface-300"
                    >
                      {key}={value}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Run info">
              <div className="space-y-1.5">
                <DetailRow label="Mode">{turn.mode}</DetailRow>
                <DetailRow label="Model access">
                  {turn.gatewayMode === 'gateway_only'
                    ? 'All calls through the gateway'
                    : turn.gatewayMode === 'mixed'
                      ? 'Some calls through the gateway'
                      : 'Direct provider credentials'}
                </DetailRow>
                {messageCount != null && (
                  <DetailRow label="Messages in conversation">{messageCount}</DetailRow>
                )}
              </div>
            </Section>

            <Section title="Identifiers">
              <div className="space-y-1.5">
                <CopyableId label="Turn" value={turn.id} />
                {turn.conversationId && <CopyableId label="Conversation" value={turn.conversationId} />}
                {turn.sandboxSessionId && <CopyableId label="Sandbox session" value={turn.sandboxSessionId} />}
                {turn.gatewayCorrelationId && <CopyableId label="Gateway correlation" value={turn.gatewayCorrelationId} />}
              </div>
            </Section>

            <Link
              to={`/events?agentId=${encodeURIComponent(agentId)}&turnId=${encodeURIComponent(turn.id)}`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-400 transition-colors hover:text-accent-300"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              View raw events for this turn
            </Link>

            <div className="border-t border-surface-800 pt-4">
              <button
                type="button"
                onClick={() => setRawExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-surface-400 transition-colors hover:text-surface-300"
              >
                {rawExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                API response
              </button>
              {rawExpanded && (
                <pre className="mt-2 overflow-x-auto rounded-md border border-surface-800 bg-surface-950 p-3 text-xs text-surface-300">
                  {JSON.stringify(turn, null, 2)}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
