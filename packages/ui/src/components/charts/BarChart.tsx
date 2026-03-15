import {
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

interface BarChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  orientation?: 'vertical' | 'horizontal';
}

const COLORS = ['#2dd4bf', '#14b8a6', '#a1a1aa', '#22c55e', '#eab308', '#ef4444'];

export function BarChart({
  title,
  data,
  xKey,
  yKey,
  orientation = 'vertical',
}: BarChartProps) {
  const yKeys = Array.isArray(yKey) ? yKey : [yKey];
  const isHorizontal = orientation === 'horizontal';

  return (
    <div data-testid="a2ui-bar-chart" className="w-full h-full bg-transparent">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <RechartsBarChart
          data={data}
          layout={isHorizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
        >
          <CartesianGrid stroke="#3f3f46" strokeOpacity={0.2} vertical={false} />
          {isHorizontal ? (
            <>
              <XAxis type="number" stroke="#3f3f46" tick={{ fill: '#71717a', fontSize: 12 }} />
              <YAxis
                type="category"
                dataKey={xKey}
                stroke="#3f3f46"
                tick={{ fill: '#71717a', fontSize: 12 }}
                width={80}
              />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} stroke="#3f3f46" tick={{ fill: '#71717a', fontSize: 12 }} />
              <YAxis stroke="#3f3f46" tick={{ fill: '#71717a', fontSize: 12 }} />
            </>
          )}
          <Tooltip
            cursor={{ stroke: '#3f3f46', fill: '#3f3f46', fillOpacity: 0.1 }}
            contentStyle={{
              backgroundColor: '#27272a',
              border: '1px solid #3f3f46',
              borderRadius: '6px',
              fontSize: '13px',
              color: '#d4d4d8',
            }}
          />
          {yKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              fill={COLORS[i % COLORS.length]}
              radius={isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            />
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
