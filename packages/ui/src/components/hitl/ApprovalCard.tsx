import { useState } from 'react';
import { Check, X, Loader2, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/utils';
import { humanizeIdentifier } from '@/lib/tool-display';

interface ApprovalCardProps {
  /** Plain name of the tool waiting on the decision. */
  toolLabel: string;
  /** Raw tool name as the harness reported it. */
  toolName: string;
  /** The agent's stated reason, when it gave one. */
  reason?: string;
  /** Context for the decision, rendered as labelled rows. */
  details?: Record<string, unknown>;
  /** True when the tool is the generic approval request, whose label adds nothing. */
  isApprovalRequest?: boolean;
  onApprove: () => void | Promise<void>;
  onReject: () => void | Promise<void>;
}

type Primitive = string | number | boolean;

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function DetailValue({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-surface-500">None</span>;
  }
  if (typeof value === 'string') {
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="tabular-nums">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-surface-500">None</span>;
    if (value.every(isPrimitive)) {
      return (
        <ul className="list-disc space-y-0.5 pl-4 marker:text-surface-500">
          {value.map((item, index) => (
            <li key={index} className="break-words">{String(item)}</li>
          ))}
        </ul>
      );
    }
  }
  if (typeof value === 'object' && !Array.isArray(value) && depth === 0) {
    return <DetailRows details={value as Record<string, unknown>} depth={depth + 1} />;
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-surface-700 bg-surface-950 p-2 font-mono text-xs text-surface-400">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function DetailRows({ details, depth }: { details: Record<string, unknown>; depth: number }) {
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,max-content)_1fr] gap-x-4 gap-y-1.5">
      {Object.entries(details).map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="pt-px text-xs text-surface-500">{humanizeIdentifier(key)}</dt>
          <dd className="min-w-0 text-[13px] leading-5 text-surface-200">
            <DetailValue value={value} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalCard({
  toolLabel,
  toolName,
  reason,
  details,
  isApprovalRequest = false,
  onApprove,
  onReject,
}: ApprovalCardProps) {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<'approve' | 'reject' | null>(null);

  const decide = async (action: 'approve' | 'reject') => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setActiveAction(action);
    try {
      await Promise.resolve(action === 'approve' ? onApprove() : onReject());
      setStatus(action === 'approve' ? 'approved' : 'rejected');
    } catch (err) {
      const fallback = action === 'approve' ? 'Approval was not sent.' : 'Rejection was not sent.';
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setIsSubmitting(false);
      setActiveAction(null);
    }
  };

  const hasDetails = details !== undefined && Object.keys(details).length > 0;
  const lead = reason?.trim() || `The agent wants to run ${toolLabel}.`;

  return (
    <div
      data-testid="approval-card"
      aria-busy={isSubmitting}
      className={cn(
        'rounded-lg border border-surface-700 border-l-2 bg-surface-850 px-4 py-3 transition-colors',
        status === 'pending' && 'border-l-accent-400',
        status === 'approved' && 'border-l-status-success',
        status === 'rejected' && 'border-l-status-error',
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 flex-shrink-0 text-accent-400" aria-hidden />
        <h3 className="text-sm font-semibold text-surface-100">Approval needed</h3>
        {!isApprovalRequest && (
          <span className="truncate text-xs text-surface-400" title={toolName}>{toolLabel}</span>
        )}
        {status !== 'pending' && (
          <span
            data-testid={status === 'approved' ? 'approval-approved' : 'approval-rejected'}
            className={cn(
              'ml-auto flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium',
              status === 'approved' && 'bg-emerald-500/20 text-emerald-400',
              status === 'rejected' && 'bg-rose-500/20 text-rose-400',
            )}
          >
            {status === 'approved' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {status === 'approved' ? 'Approved' : 'Rejected'}
          </span>
        )}
      </div>

      <p data-testid="approval-reason" className="mt-1.5 text-sm leading-6 text-surface-100">
        {lead}
      </p>

      {hasDetails && (
        <div className="mt-2.5 max-h-40 overflow-y-auto rounded-md border border-surface-700/60 bg-surface-900/60 px-3 py-2">
          <DetailRows details={details} depth={0} />
        </div>
      )}

      {status === 'pending' && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <button
              data-testid="approve-button"
              type="button"
              onClick={() => decide('approve')}
              disabled={isSubmitting}
              className="btn-primary px-4 py-1.5 disabled:cursor-not-allowed"
            >
              {isSubmitting && activeAction === 'approve'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Check className="h-4 w-4" />}
              Approve
            </button>
            <button
              type="button"
              data-testid="reject-button"
              onClick={() => decide('reject')}
              disabled={isSubmitting}
              className="btn-secondary px-4 py-1.5 hover:border-red-500/50 hover:text-red-300 disabled:cursor-not-allowed"
            >
              {isSubmitting && activeAction === 'reject'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <X className="h-4 w-4" />}
              Reject
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-2 rounded-md bg-status-error/10 px-3 py-2 text-sm text-status-error">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="ml-auto underline hover:text-red-300"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
