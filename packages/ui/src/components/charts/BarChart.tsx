import {
  ResponsiveContainer,
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
} from 'recharts';
import {
  CHART_GRID_COLOR,
  CHART_TICK_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_STYLE,
  CHART_VALUE_TEXT,
  formatAxisNumber,
  formatChartValue,
  niceValueTicks,
  resolveChartHeight,
  resolveSeriesColors,
  truncateLabel,
} from './chart-style';

interface BarChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  orientation?: 'vertical' | 'horizontal';
  color?: string;
  colors?: string[];
  height?: number;
}

/** Direct value labels stay readable up to this many bars in a single series. */
const VALUE_LABEL_LIMIT = 12;
const MAX_BAR_THICKNESS = 40;

// Recharts 2.x flattens chart children with react-is 18, which does not
// recognise React 19 fragments: axes wrapped in <>…</> silently vanish. Keep
// every axis a direct child of the chart.
export function BarChart({
  title,
  data,
  xKey,
  yKey,
  orientation = 'vertical',
  color,
  colors,
  height,
}: BarChartProps) {
  const rows = Array.isArray(data) ? data : [];
  const yKeys = (Array.isArray(yKey) ? yKey : [yKey])
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  const isHorizontal = orientation === 'horizontal';
  const seriesColors = resolveSeriesColors(yKeys.length, { color, colors });
  const showValueLabels = yKeys.length === 1 && rows.length > 0 && rows.length <= VALUE_LABEL_LIMIT;
  const labelMaxLength = rows.length > 6 ? 12 : 24;
  const longestLabel = rows.reduce(
    (longest, row) => Math.max(longest, truncateLabel(row[xKey], labelMaxLength).length),
    0,
  );
  const categoryAxisWidth = Math.min(180, Math.max(48, longestLabel * 7 + 12));
  const formatCategory = (value: unknown) => truncateLabel(value, labelMaxLength);
  const valueTicks = niceValueTicks(rows, yKeys);
  const valueDomain: [number, number] | undefined = valueTicks
    ? [valueTicks[0], valueTicks[valueTicks.length - 1]]
    : undefined;

  return (
    <div data-testid="a2ui-bar-chart" className="w-full h-full bg-transparent font-sans">
      {title && (
        <h3 className="mb-3 text-sm font-semibold text-surface-200">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={resolveChartHeight(height)}>
        <RechartsBarChart
          data={rows}
          layout={isHorizontal ? 'vertical' : 'horizontal'}
          margin={{
            top: showValueLabels && !isHorizontal ? 22 : 8,
            right: showValueLabels && isHorizontal ? 56 : 12,
            left: 0,
            bottom: 0,
          }}
          barCategoryGap="24%"
        >
          <CartesianGrid
            stroke={CHART_GRID_COLOR}
            strokeOpacity={0.5}
            horizontal={!isHorizontal}
            vertical={isHorizontal}
          />
          {isHorizontal ? (
            <XAxis
              type="number"
              ticks={valueTicks}
              domain={valueDomain}
              tick={CHART_TICK_STYLE}
              tickFormatter={formatAxisNumber}
              tickLine={false}
              axisLine={false}
            />
          ) : (
            <XAxis
              type="category"
              dataKey={xKey}
              tick={CHART_TICK_STYLE}
              tickFormatter={formatCategory}
              tickLine={false}
              axisLine={{ stroke: CHART_GRID_COLOR }}
              interval={rows.length <= VALUE_LABEL_LIMIT ? 0 : 'preserveStartEnd'}
              tickMargin={8}
            />
          )}
          {isHorizontal ? (
            <YAxis
              type="category"
              dataKey={xKey}
              tick={CHART_TICK_STYLE}
              tickFormatter={formatCategory}
              tickLine={false}
              axisLine={{ stroke: CHART_GRID_COLOR }}
              width={categoryAxisWidth}
              interval={0}
            />
          ) : (
            <YAxis
              type="number"
              ticks={valueTicks}
              domain={valueDomain}
              tick={CHART_TICK_STYLE}
              tickFormatter={formatAxisNumber}
              tickLine={false}
              axisLine={false}
              width={48}
            />
          )}
          <Tooltip
            cursor={{ fill: CHART_GRID_COLOR, fillOpacity: 0.25 }}
            contentStyle={CHART_TOOLTIP_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            formatter={(value: unknown) => formatChartValue(value)}
          />
          {yKeys.length > 1 && (
            <Legend formatter={(value) => <span className="text-xs text-surface-400">{value}</span>} />
          )}
          {yKeys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              name={key}
              fill={seriesColors[index]}
              maxBarSize={MAX_BAR_THICKNESS}
              radius={isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              isAnimationActive={false}
            >
              {showValueLabels && (
                <LabelList
                  dataKey={key}
                  position={isHorizontal ? 'right' : 'top'}
                  formatter={formatChartValue}
                  fill={CHART_VALUE_TEXT}
                  fontSize={12}
                  offset={6}
                />
              )}
            </Bar>
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>
    </div>
  );
}
