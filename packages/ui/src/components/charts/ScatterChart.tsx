import {
  ResponsiveContainer,
  ScatterChart as RechartsScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

const COLORS = ['#2dd4bf', '#14b8a6', '#a1a1aa', '#22c55e', '#eab308', '#ef4444'];

interface ScatterChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  color?: string;
  width?: number;
  height?: number;
}

export function ScatterChart({
  title,
  data,
  xKey,
  yKey,
  color,
}: ScatterChartProps) {
  return (
    <div data-testid="a2ui-scatter-chart" className="w-full h-full bg-transparent">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <RechartsScatterChart margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <CartesianGrid stroke="#3f3f46" strokeOpacity={0.2} />
          <XAxis
            dataKey={xKey}
            type="number"
            stroke="#3f3f46"
            tick={{ fill: '#71717a', fontSize: 12 }}
            name={xKey}
          />
          <YAxis
            dataKey={yKey}
            type="number"
            stroke="#3f3f46"
            tick={{ fill: '#71717a', fontSize: 12 }}
            name={yKey}
          />
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
          <Scatter
            data={data}
            fill={color ?? COLORS[0]}
          />
        </RechartsScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
