import { TrendingUp, TrendingDown } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  title: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  sparkline?: number[];
}

export function MetricCard({ title, value, change, changeLabel, sparkline }: MetricCardProps) {
  const isPositive = change !== undefined && change >= 0;

  return (
    <div data-testid="a2ui-metric-card" className="card p-5">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs font-medium uppercase tracking-wider text-surface-400">
            {title}
          </p>
          <p data-testid="metric-value" className="mt-2 text-3xl font-bold text-surface-100 tracking-tight">
            {value}
          </p>
          {change !== undefined && (
            <div
              data-testid="metric-change"
              className={cn(
                'mt-2 flex items-center gap-1 text-sm font-medium',
                isPositive ? 'text-green-400' : 'text-red-400',
              )}
            >
              {isPositive ? (
                <TrendingUp className="h-3.5 w-3.5" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5" />
              )}
              <span>
                {isPositive ? '+' : ''}
                {change}%
              </span>
              {changeLabel && (
                <span className="text-surface-500 font-normal">{changeLabel}</span>
              )}
            </div>
          )}
        </div>
        {sparkline && sparkline.length > 0 && (
          <div className="w-24 h-12">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkline.map((v) => ({ value: v }))}>
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={isPositive ? '#10b981' : '#ef4444'}
                  strokeWidth={1.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
