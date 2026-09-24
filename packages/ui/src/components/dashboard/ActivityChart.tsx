import { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AnalyticsOverview, AnalyticsWindow } from '@stablehand/contracts';
import { cn } from '@/lib/utils';
import { formatCompactNumber } from '@/lib/format';

const WINDOWS: AnalyticsWindow[] = ['24h', '7d', '30d'];

function bucketLabel(timestamp: number, window: AnalyticsWindow): string {
  const date = new Date(timestamp);
  if (window === '24h') {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface ActivityChartProps {
  overview: AnalyticsOverview | null;
  window: AnalyticsWindow;
  onWindowChange: (window: AnalyticsWindow) => void;
  loading?: boolean;
}

/**
 * Runs by outcome (stacked bars) with known spend as a line overlay — the
 * dashboard's single glanceable chart; the Analytics page stays the deep dive.
 */
export function ActivityChart({ overview, window, onWindowChange, loading }: ActivityChartProps) {
  const chartData = useMemo(() => {
    if (!overview) return [];
    return overview.activity.map((bucket) => ({
      label: bucketLabel(bucket.from, overview.window),
      completed: bucket.completedTurns,
      errors: bucket.errorTurns,
      cancelled: bucket.cancelledTurns,
      spend: bucket.knownCostUsd,
    }));
  }, [overview]);

  return (
    <div className="rounded-lg border border-surface-700 bg-surface-800/30 p-4" data-testid="dashboard-activity-chart">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h3 className="text-sm font-medium text-surface-300">Runs</h3>
          <div className="flex items-center gap-3 text-[11px] text-surface-400">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2 rounded-sm bg-teal-400/80" />Completed</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2 rounded-sm bg-red-400/80" />Errors</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2 rounded-sm bg-surface-500/80" />Cancelled</span>
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-amber-400" />Spend</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => onWindowChange(entry)}
              className={cn(
                'rounded-md px-2 py-0.5 text-xs transition-colors',
                window === entry
                  ? 'bg-surface-700 text-surface-100'
                  : 'text-surface-400 hover:text-surface-200',
              )}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>
      <div className="h-[240px]">
        {loading && chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-surface-500">Loading…</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#3f3f46" strokeDasharray="3 5" vertical={false} opacity={0.45} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#a1a1aa', fontSize: 11 }}
                minTickGap={28}
              />
              <YAxis
                yAxisId="runs"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#a1a1aa', fontSize: 11 }}
                allowDecimals={false}
                width={34}
              />
              <YAxis
                yAxisId="spend"
                orientation="right"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#a1a1aa', fontSize: 11 }}
                tickFormatter={(value: number) => `$${value >= 1 ? value.toFixed(0) : value.toFixed(2)}`}
                width={44}
              />
              <Tooltip
                contentStyle={{
                  background: '#18181b',
                  border: '1px solid #3f3f46',
                  borderRadius: 8,
                  color: '#f4f4f5',
                  fontSize: 12,
                }}
                cursor={{ fill: '#3f3f46', opacity: 0.18 }}
                formatter={(value: number, name: string) =>
                  name === 'Spend' ? [`$${value.toFixed(4)}`, name] : [formatCompactNumber(value), name]}
              />
              <Bar yAxisId="runs" dataKey="completed" name="Completed" stackId="runs" fill="#2dd4bf" opacity={0.8} maxBarSize={14} />
              <Bar yAxisId="runs" dataKey="errors" name="Errors" stackId="runs" fill="#f87171" opacity={0.85} maxBarSize={14} />
              <Bar yAxisId="runs" dataKey="cancelled" name="Cancelled" stackId="runs" fill="#71717a" opacity={0.7} radius={[3, 3, 0, 0]} maxBarSize={14} />
              <Line
                yAxisId="spend"
                type="monotone"
                dataKey="spend"
                name="Spend"
                stroke="#fbbf24"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, fill: '#fbbf24', stroke: '#0a0a0b' }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
