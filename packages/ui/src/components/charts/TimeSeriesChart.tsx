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

const COLORS = ['#2dd4bf', '#14b8a6', '#a1a1aa', '#22c55e', '#eab308', '#ef4444'];

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
    <div data-testid="a2ui-time-series-chart" className="w-full h-full bg-transparent">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <ChartComponent data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid stroke="#3f3f46" strokeOpacity={0.2} vertical={false} />
          <XAxis
            dataKey={xKey}
            stroke="#3f3f46"
            tick={{ fill: '#71717a', fontSize: 12 }}
          />
          <YAxis stroke="#3f3f46" tick={{ fill: '#71717a', fontSize: 12 }} />
          <Tooltip
            cursor={{ stroke: '#3f3f46' }}
            contentStyle={{
              backgroundColor: '#27272a',
              border: '1px solid #3f3f46',
              borderRadius: '6px',
              color: '#d4d4d8',
              fontSize: '13px',
            }}
          />
          {yKeys.length > 1 && <Legend formatter={(value) => <span className="text-xs text-surface-400">{value}</span>} />}
          {yKeys.map((key, i) =>
            chartType === 'area' ? (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.1}
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
                activeDot={{ r: 4, fill: COLORS[i % COLORS.length], stroke: '#27272a', strokeWidth: 2 }}
              />
            ),
          )}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}
