import {
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
} from 'recharts';

const COLORS = ['#2dd4bf', '#14b8a6', '#a1a1aa', '#22c55e', '#eab308', '#ef4444'];

interface PieChartProps {
  title?: string;
  data: Record<string, unknown>[];
  nameKey: string;
  valueKey: string;
  donut?: boolean;
}

export function PieChart({
  title,
  data,
  nameKey,
  valueKey,
  donut = false,
}: PieChartProps) {
  return (
    <div data-testid="a2ui-pie-chart" className="w-full h-full bg-transparent">
      {title && (
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      )}
      <ResponsiveContainer width="100%" height={300}>
        <RechartsPieChart>
          <Pie
            data={data}
            dataKey={valueKey}
            nameKey={nameKey}
            cx="50%"
            cy="50%"
            innerRadius={donut ? 60 : 0}
            outerRadius={100}
            strokeWidth={1}
            stroke="#3f3f46"
            label={({ name, percent }) =>
              `${name} ${(percent * 100).toFixed(0)}%`
            }
            labelLine={{ stroke: '#3f3f46' }}
          >
            {data.map((_, index) => (
              <Cell key={index} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: '#27272a',
              border: '1px solid #3f3f46',
              borderRadius: '6px',
              color: '#d4d4d8',
              fontSize: '13px',
            }}
            itemStyle={{ color: '#d4d4d8' }}
          />
          <Legend formatter={(value) => <span className="text-xs text-surface-500">{value}</span>} />
        </RechartsPieChart>
      </ResponsiveContainer>
    </div>
  );
}
