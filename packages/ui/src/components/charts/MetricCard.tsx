import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  title: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  trend?: 'up' | 'down' | 'flat';
  prefix?: string;
  suffix?: string;
  description?: string;
}

function resolveTrend(change: number | undefined, trend: unknown): 'up' | 'down' | 'flat' | null {
  if (trend === 'up' || trend === 'down' || trend === 'flat') return trend;
  if (typeof change !== 'number' || !Number.isFinite(change)) return null;
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

export function MetricCard({
  title,
  value,
  change,
  changeLabel,
  trend,
  prefix,
  suffix,
  description,
}: MetricCardProps) {
  const direction = resolveTrend(change, trend);
  const hasChange = typeof change === 'number' && Number.isFinite(change);
  const TrendIcon = direction === 'up' ? ArrowUpRight : direction === 'down' ? ArrowDownRight : ArrowRight;
  const displayValue = typeof value === 'number' ? value.toLocaleString() : String(value ?? '');

  return (
    <div
      data-testid="a2ui-metric-card"
      className="rounded-lg border border-surface-700 bg-surface-800 px-4 py-3 font-sans"
    >
      <div className="flex flex-col gap-1">
        <p className="text-label">{title}</p>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p data-testid="metric-value" className="text-2xl font-semibold tabular-nums text-surface-100">
            {prefix && <span className="mr-0.5 text-lg font-medium text-surface-300">{prefix}</span>}
            {displayValue}
            {suffix && <span className="ml-1 text-sm font-normal text-surface-400">{suffix.trim()}</span>}
          </p>
          {(hasChange || direction) && (
            <span
              data-testid="metric-change"
              className={cn(
                'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
                direction === 'up' && 'text-status-success',
                direction === 'down' && 'text-status-error',
                direction === 'flat' && 'text-surface-400',
              )}
            >
              <TrendIcon className="h-3.5 w-3.5" aria-hidden />
              {hasChange && `${Math.abs(change)}%`}
              {changeLabel && <span className="ml-1 font-normal text-surface-400">{changeLabel}</span>}
            </span>
          )}
          {!hasChange && !direction && changeLabel && (
            <span className="text-xs text-surface-400">{changeLabel}</span>
          )}
        </div>
        {description && (
          <p className="text-xs text-surface-400">{description}</p>
        )}
      </div>
    </div>
  );
}
