import { useState } from 'react';
import { Check, X } from 'lucide-react';
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

  const handleApprove = () => {
    setStatus('approved');
    onApprove();
  };

  const handleReject = () => {
    setStatus('rejected');
    onReject();
  };

  return (
    <div
      data-testid="approval-card"
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
            <p className="text-xs font-medium uppercase tracking-wider text-surface-500 mb-1">Action</p>
            <p className="text-sm text-surface-200 font-mono">{action}</p>
          </div>

          {details && Object.keys(details).length > 0 && (
            <div className="mt-3 space-y-1">
              {Object.entries(details).map(([key, value]) => (
                <div key={key} className="flex items-baseline gap-2 text-sm">
                  <span className="text-surface-500 font-medium">{key}:</span>
                  <span className="text-surface-300">{String(value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {status !== 'pending' && (
          <div
            data-testid="approval-approved"
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
        <div className="mt-4 flex items-center gap-3">
          <button
            data-testid="approve-button"
            type="button"
            onClick={handleApprove}
            className="btn-primary"
          >
            Approve
          </button>
          <button
            type="button"
            data-testid="reject-button"
            onClick={handleReject}
            className="text-sm text-status-error hover:text-red-300 transition-colors"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
