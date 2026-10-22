import { CircleDollarSign } from 'lucide-react';
import { describeTurnStopReason, type TurnStopReason } from '@stablehand/contracts';
import { cn } from '@/lib/utils';

interface BudgetStopBannerProps {
  reason: TurnStopReason;
  className?: string;
}

/**
 * Receipt for a run the gateway stopped at its spend cap. Amber, not red:
 * the run did what its budget allowed and stopped on purpose. The wording
 * comes from contracts so the dashboard and the API's turn error agree.
 */
export function BudgetStopBanner({ reason, className }: BudgetStopBannerProps) {
  const { summary, detail } = describeTurnStopReason(reason);
  return (
    <div
      data-testid="budget-stop-banner"
      role="status"
      className={cn(
        'flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 animate-fade-in',
        className,
      )}
    >
      <CircleDollarSign className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-amber-200">{summary}</p>
        {detail && <p className="text-xs text-amber-200/75">{detail}</p>}
      </div>
    </div>
  );
}
