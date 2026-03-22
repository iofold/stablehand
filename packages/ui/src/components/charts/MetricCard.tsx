import { cn } from '@/lib/utils';

interface MetricCardProps {
  title: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
}

export function MetricCard({ title, value, change, changeLabel }: MetricCardProps) {
  const isPositive = change !== undefined && change >= 0;

  return (
    <div 
      data-testid="a2ui-metric-card" 
      className="border border-surface-700 rounded-lg bg-surface-800 px-4 py-3"
    >
      <div className="flex flex-col gap-1">
        <p className="text-label">
          {title}
        </p>
        <div className="flex items-baseline gap-2">
          <p data-testid="metric-value" className="text-2xl font-semibold text-surface-100 tabular-nums">
            {value}
          </p>
          {change !== undefined && (
            <span
              data-testid="metric-change"
              className={cn(
                'text-xs font-medium',
                isPositive ? 'text-status-success' : 'text-status-error',
              )}
            >
              {isPositive ? '↑' : '↓'}
              {Math.abs(change)}%
            </span>
          )}
        </div>
        {changeLabel && (
          <p className="text-xs text-surface-400">{changeLabel}</p>
        )}
      </div>
    </div>
  );
}
