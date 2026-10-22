import {
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from 'recharts';
import {
  CHART_GRID_COLOR,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_STYLE,
  CHART_VALUE_TEXT,
  formatChartValue,
  resolveChartHeight,
  resolveSeriesColors,
} from './chart-style';

interface PieChartProps {
  title?: string;
  data: Record<string, unknown>[];
  nameKey: string;
  valueKey: string;
  donut?: boolean;
  colors?: string[];
  height?: number;
}

interface PieLabelProps {
  x: number;
  y: number;
  textAnchor: 'start' | 'middle' | 'end' | 'inherit';
  name?: string;
  percent?: number;
}

/** Slice labels use the text token; Recharts' default paints them in the slice colour. */
function PieLabel({ x, y, textAnchor, name, percent }: PieLabelProps) {
  return (
    <text x={x} y={y} textAnchor={textAnchor} dominantBaseline="central" fill={CHART_VALUE_TEXT} fontSize={12}>
      {`${name ?? ''} ${Math.round((percent ?? 0) * 100)}%`}
    </text>
  );
}

export function PieChart({
  title,
  data,
  nameKey,
  valueKey,
  donut = false,
  colors,
  height,
}: PieChartProps) {
  const rows = Array.isArray(data) ? data : [];
  const sliceColors = resolveSeriesColors(rows.length, { colors });
  return (
    <div data-testid="a2ui-pie-chart" className="w-full h-full bg-transparent font-sans">
      {title && (
        <h3 className="mb-3 text-sm font-semibold text-surface-200">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={resolveChartHeight(height, 300)}>
        <RechartsPieChart>
          <Pie
            data={rows}
            dataKey={valueKey}
            nameKey={nameKey}
            cx="50%"
            cy="50%"
            innerRadius={donut ? 60 : 0}
            outerRadius={100}
            strokeWidth={2}
            stroke="#151517"
            label={PieLabel}
            labelLine={{ stroke: CHART_GRID_COLOR }}
            isAnimationActive={false}
          >
            {rows.map((_, index) => (
              <Cell key={index} fill={sliceColors[index]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
            formatter={(value: unknown) => formatChartValue(value)}
          />
          <Legend formatter={(value) => <span className="text-xs text-surface-400">{value}</span>} />
        </RechartsPieChart>
      </ResponsiveContainer>
    </div>
  );
}
