import { useMemo } from 'react';

interface CandlestickData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface CandlestickChartProps {
  title: string;
  data: CandlestickData[];
}

export function CandlestickChart({ title, data }: CandlestickChartProps) {
  const layout = useMemo(() => {
    if (data.length === 0) return null;

    const width = 800;
    const mainHeight = 240;
    const volumeHeight = 60;
    const totalHeight = mainHeight + volumeHeight + 40;
    const paddingX = 60;
    const paddingTop = 8;
    const gap = 20;

    const allHigh = Math.max(...data.map((d) => d.high));
    const allLow = Math.min(...data.map((d) => d.low));
    const priceRange = allHigh - allLow || 1;
    const pricePad = priceRange * 0.05;

    const maxVolume = Math.max(...data.map((d) => d.volume ?? 0)) || 1;

    const barWidth = Math.max(2, Math.min(16, (width - paddingX * 2) / data.length - 2));

    const scaleY = (v: number) =>
      paddingTop + mainHeight - ((v - (allLow - pricePad)) / (priceRange + pricePad * 2)) * mainHeight;

    const volumeBase = mainHeight + gap + volumeHeight;
    const scaleVolY = (v: number) => volumeBase - (v / maxVolume) * volumeHeight;

    const step = (width - paddingX * 2) / Math.max(data.length - 1, 1);

    return { width, totalHeight, mainHeight, paddingX, paddingTop, allHigh, allLow, priceRange, pricePad, barWidth, scaleY, scaleVolY, step, volumeBase };
  }, [data]);

  if (!layout || data.length === 0) {
    return (
      <div data-testid="a2ui-candlestick-chart" className="card p-4">
        <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
        <p className="text-surface-400 text-sm">No data available</p>
      </div>
    );
  }

  const { width, totalHeight, paddingX, scaleY, scaleVolY, step, barWidth, volumeBase, allHigh, allLow, pricePad } = layout;

  const tickCount = 5;
  const minPrice = allLow - pricePad;
  const maxPrice = allHigh + pricePad;
  const priceTicks = Array.from({ length: tickCount }, (_, i) =>
    minPrice + ((maxPrice - minPrice) * i) / (tickCount - 1),
  );

  return (
    <div data-testid="a2ui-candlestick-chart" className="card p-4">
      <h3 className="text-sm font-semibold text-surface-200 mb-4">{title}</h3>
      <svg
        viewBox={`0 0 ${width} ${totalHeight + 24}`}
        className="w-full"
        style={{ maxHeight: totalHeight + 24 }}
      >
        {priceTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={paddingX}
              x2={width - 10}
              y1={scaleY(tick)}
              y2={scaleY(tick)}
              stroke="#334155"
              strokeDasharray="3 3"
            />
            <text
              x={paddingX - 6}
              y={scaleY(tick) + 3}
              textAnchor="end"
              fill="#94a3b8"
              fontSize={10}
            >
              {tick.toFixed(2)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const x = paddingX + i * step;
          const isUp = d.close >= d.open;
          const color = isUp ? '#10b981' : '#ef4444';
          const bodyTop = scaleY(Math.max(d.open, d.close));
          const bodyBottom = scaleY(Math.min(d.open, d.close));
          const bodyHeight = Math.max(1, bodyBottom - bodyTop);

          return (
            <g key={i}>
              <line x1={x} x2={x} y1={scaleY(d.high)} y2={scaleY(d.low)} stroke={color} strokeWidth={1} />
              <rect
                x={x - barWidth / 2}
                y={bodyTop}
                width={barWidth}
                height={bodyHeight}
                fill={color}
                stroke={color}
                strokeWidth={0.5}
                rx={1}
              />
            </g>
          );
        })}

        {data.map((d, i) => {
          if (d.volume == null) return null;
          const x = paddingX + i * step;
          const isUp = d.close >= d.open;
          const color = isUp ? '#10b98166' : '#ef444466';
          const volY = scaleVolY(d.volume);
          return (
            <rect
              key={`vol-${i}`}
              x={x - barWidth / 2}
              y={volY}
              width={barWidth}
              height={volumeBase - volY}
              fill={color}
              rx={1}
            />
          );
        })}

        {data.map((d, i) => {
          if (data.length <= 10 || i % Math.ceil(data.length / 8) === 0) {
            const x = paddingX + i * step;
            return (
              <text key={`date-${i}`} x={x} y={totalHeight + 18} textAnchor="middle" fill="#94a3b8" fontSize={9}>
                {d.date}
              </text>
            );
          }
          return null;
        })}
      </svg>
    </div>
  );
}
