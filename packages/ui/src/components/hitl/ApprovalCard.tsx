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
        'rounded-lg border p-5 transition-colors',
        status === 'pending' && 'border-zinc-700 bg-zinc-900',
        status === 'approved' && 'border-emerald-700/50 bg-emerald-950/20',
        status === 'rejected' && 'border-rose-700/50 bg-rose-950/20',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          <p className="mt-1 text-sm text-zinc-400">{description}</p>

          <div className="mt-3 rounded-md bg-zinc-800 px-3 py-2">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500 mb-1">Action</p>
            <p className="text-sm text-zinc-200 font-mono">{action}</p>
          </div>

          {details && Object.keys(details).length > 0 && (
            <div className="mt-3 space-y-1">
              {Object.entries(details).map(([key, value]) => (
                <div key={key} className="flex items-baseline gap-2 text-sm">
                  <span className="text-zinc-500 font-medium">{key}:</span>
                  <span className="text-zinc-300">{String(value)}</span>
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
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-500 transition-colors"
          >
            <Check className="h-4 w-4" />
            Approve
          </button>
          <button
            type="button"
            data-testid="reject-button"
            onClick={handleReject}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 border border-zinc-700 hover:bg-zinc-700 transition-colors"
          >
            <X className="h-4 w-4" />
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
