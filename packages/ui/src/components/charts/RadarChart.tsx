import {
  ResponsiveContainer,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
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
  resolveChartHeight,
  resolveSeriesColors,
} from './chart-style';

interface RadarChartProps {
  title?: string;
  data: Record<string, unknown>[];
  dataKey: string | string[];
  color?: string;
  colors?: string[];
  height?: number;
}

export function RadarChart({
  title,
  data,
  dataKey,
  color,
  colors,
  height,
}: RadarChartProps) {
  const rows = Array.isArray(data) ? data : [];
  const dataKeys = (Array.isArray(dataKey) ? dataKey : [dataKey])
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  const seriesColors = resolveSeriesColors(dataKeys.length, { color, colors });
  // The first string field that is not a plotted value labels the spokes.
  const angleKey = rows.length > 0
    ? Object.keys(rows[0]).find((k) => !dataKeys.includes(k) && typeof rows[0][k] === 'string') ?? 'subject'
    : 'subject';

  return (
    <div data-testid="a2ui-radar-chart" className="w-full h-full bg-transparent font-sans">
      {title && (
        <h3 className="mb-3 text-sm font-semibold text-surface-200">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={resolveChartHeight(height, 300)}>
        <RechartsRadarChart data={rows} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke={CHART_GRID_COLOR} strokeOpacity={0.6} />
          <PolarAngleAxis dataKey={angleKey} tick={CHART_TICK_STYLE} />
          <PolarRadiusAxis
            tick={{ ...CHART_TICK_STYLE, fontSize: 10 }}
            tickFormatter={formatAxisNumber}
            stroke={CHART_GRID_COLOR}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            formatter={(value: unknown) => formatChartValue(value)}
          />
          {dataKeys.length > 1 && (
            <Legend formatter={(value) => <span className="text-xs text-surface-400">{value}</span>} />
          )}
          {dataKeys.map((key, index) => (
            <Radar
              key={key}
              dataKey={key}
              name={key}
              stroke={seriesColors[index]}
              fill={seriesColors[index]}
              fillOpacity={0.15}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </RechartsRadarChart>
      </ResponsiveContainer>
    </div>
  );
}
