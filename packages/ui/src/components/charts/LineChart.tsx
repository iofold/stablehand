import { TimeSeriesChart } from './TimeSeriesChart';

interface LineChartProps {
  title?: string;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  width?: number;
  height?: number;
}

export function LineChart(props: LineChartProps) {
  return <TimeSeriesChart {...props} chartType="line" />;
}
