import {
  ResponsiveContainer,
  ScatterChart as RechartsScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import {
  CHART_GRID_COLOR,
  CHART_TICK_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_STYLE,
  formatAxisNumber,
  formatChartValue,
  resolveChartHeight,
  resolveSeriesColors,
} from './chart-style';

interface ScatterChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  color?: string;
  height?: number;
}

export function ScatterChart({
  title,
  data,
  xKey,
  yKey,
  color,
  height,
}: ScatterChartProps) {
  const [pointColor] = resolveSeriesColors(1, { color });
  return (
    <div data-testid="a2ui-scatter-chart" className="w-full h-full bg-transparent font-sans">
      {title && (
        <h3 className="mb-3 text-sm font-semibold text-surface-200">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={resolveChartHeight(height)}>
        <RechartsScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_COLOR} strokeOpacity={0.5} />
          <XAxis
            dataKey={xKey}
            type="number"
            name={xKey}
            tick={CHART_TICK_STYLE}
            tickFormatter={formatAxisNumber}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID_COLOR }}
            tickMargin={8}
          />
          <YAxis
            dataKey={yKey}
            type="number"
            name={yKey}
            tick={CHART_TICK_STYLE}
            tickFormatter={formatAxisNumber}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip
            cursor={{ stroke: CHART_GRID_COLOR }}
            contentStyle={CHART_TOOLTIP_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            formatter={(value: unknown) => formatChartValue(value)}
          />
          <Scatter data={Array.isArray(data) ? data : []} fill={pointColor} isAnimationActive={false} />
        </RechartsScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
