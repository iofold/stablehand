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
import {
  CHART_GRID_COLOR,
  CHART_TICK_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_STYLE,
  formatAxisNumber,
  formatChartValue,
  niceValueTicks,
  resolveChartHeight,
  resolveSeriesColors,
  truncateLabel,
} from './chart-style';

interface TimeSeriesChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  chartType?: 'line' | 'area';
  color?: string;
  colors?: string[];
  height?: number;
}

export function TimeSeriesChart({
  title,
  data,
  xKey,
  yKey,
  chartType = 'line',
  color,
  colors,
  height,
}: TimeSeriesChartProps) {
  const rows = Array.isArray(data) ? data : [];
  const yKeys = (Array.isArray(yKey) ? yKey : [yKey])
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  const seriesColors = resolveSeriesColors(yKeys.length, { color, colors });
  const ChartComponent = chartType === 'area' ? AreaChart : LineChart;
  const valueTicks = niceValueTicks(rows, yKeys);

  return (
    <div data-testid="a2ui-time-series-chart" className="w-full h-full bg-transparent font-sans">
      {title && (
        <h3 className="mb-3 text-sm font-semibold text-surface-200">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={resolveChartHeight(height)}>
        <ChartComponent data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_COLOR} strokeOpacity={0.5} vertical={false} />
          <XAxis
            dataKey={xKey}
            tick={CHART_TICK_STYLE}
            tickFormatter={(value: unknown) => truncateLabel(value, 14)}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID_COLOR }}
            interval="preserveStartEnd"
            minTickGap={16}
            tickMargin={8}
          />
          <YAxis
            ticks={valueTicks}
            domain={valueTicks ? [valueTicks[0], valueTicks[valueTicks.length - 1]] : undefined}
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
          {yKeys.length > 1 && (
            <Legend formatter={(value) => <span className="text-xs text-surface-400">{value}</span>} />
          )}
          {yKeys.map((key, index) =>
            chartType === 'area' ? (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stroke={seriesColors[index]}
                fill={seriesColors[index]}
                fillOpacity={0.1}
                strokeWidth={2}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stroke={seriesColors[index]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: seriesColors[index], stroke: '#27272a', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ),
          )}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}
