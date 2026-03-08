import {
  ResponsiveContainer,
  LineChart,
  AreaChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

interface TimeSeriesChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  chartType?: 'line' | 'area';
}

export function TimeSeriesChart({
  title,
  data,
  xKey,
  yKey,
  chartType = 'line',
}: TimeSeriesChartProps) {
  const yKeys = Array.isArray(yKey) ? yKey : [yKey];
  const ChartComponent = chartType === 'area' ? AreaChart : LineChart;

  return (
    <div data-testid="a2ui-time-series-chart" className="card p-4">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <ChartComponent data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey={xKey}
            stroke="#64748b"
            tick={{ fill: '#94a3b8', fontSize: 11 }}
          />
          <YAxis stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
              color: '#e2e8f0',
              fontSize: 12,
            }}
          />
          {yKeys.length > 1 && <Legend />}
          {yKeys.map((key, i) =>
            chartType === 'area' ? (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            ) : (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ),
          )}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}
