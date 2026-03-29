import { useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ApprovalCardProps {
  title: string;
  description: string;
  action: string;
  details?: Record<string, unknown>;
  onApprove: () => void;
  onReject: () => void;
}

export function ApprovalCard({ title, description, action, details, onApprove, onReject }: ApprovalCardProps) {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<'approve' | 'reject' | null>(null);

  const handleApprove = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setActiveAction('approve');
    try {
      await Promise.resolve(onApprove());
      setStatus('approved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setIsSubmitting(false);
      setActiveAction(null);
    }
  };

  const handleReject = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    setActiveAction('reject');
    try {
      await Promise.resolve(onReject());
      setStatus('rejected');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setIsSubmitting(false);
      setActiveAction(null);
    }
  };

  return (
    <div
      data-testid="approval-card"
      aria-busy={isSubmitting}
      className={cn(
        'border border-surface-700 rounded-lg bg-surface-800 p-4 transition-colors',
        status === 'pending' && 'border-l-2 border-l-accent-400',
        status === 'approved' && 'border-l-2 border-l-status-success',
        status === 'rejected' && 'border-l-2 border-l-status-error',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-surface-200">{title}</h3>
          <p className="mt-1 text-sm text-surface-400">{description}</p>

          <div className="mt-3 rounded-md bg-surface-800 px-3 py-2 border border-surface-700/50">
            <p className="text-xs font-medium uppercase tracking-wider text-surface-400 mb-1">Action</p>
            <p className="text-sm text-surface-200 font-mono">{action}</p>
          </div>

          {details && Object.keys(details).length > 0 && (
            <div className="mt-3 space-y-1">
              {Object.entries(details).map(([key, value]) => (
                <div key={key} className="flex items-baseline gap-2 text-sm">
                  <span className="text-surface-400 font-medium">{key}:</span>
                  <span className="text-surface-300">
                    {typeof value === 'object' && value !== null
                      ? JSON.stringify(value, null, 2)
                      : String(value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {status !== 'pending' && (
          <div
            data-testid={status === 'approved' ? 'approval-approved' : 'approval-rejected'}
            className={cn(
              'flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium',
              status === 'approved' && 'bg-emerald-500/20 text-emerald-400',
              status === 'rejected' && 'bg-rose-500/20 text-rose-400',
            )}
          >
            {status === 'approved' ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {status === 'approved' ? 'Approved' : 'Rejected'}
          </div>
        )}
      </div>

      {status === 'pending' && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button
              data-testid="approve-button"
              type="button"
              onClick={handleApprove}
              disabled={isSubmitting}
              className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting && activeAction === 'approve' && <Loader2 className="h-4 w-4 animate-spin" />}
              Approve
            </button>
            <button
              type="button"
              data-testid="reject-button"
              onClick={handleReject}
              disabled={isSubmitting}
              className="text-sm text-status-error hover:text-red-300 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting && activeAction === 'reject' && <Loader2 className="h-4 w-4 animate-spin" />}
              Reject
            </button>
          </div>
          {error && (
            <div className="flex items-center gap-2 text-sm text-status-error bg-status-error/10 px-3 py-2 rounded-md">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                className="ml-auto underline hover:text-red-300"
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
