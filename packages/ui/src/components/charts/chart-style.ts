import type { CSSProperties } from 'react';

/**
 * Categorical series colours for A2UI charts, assigned in this fixed order.
 * Validated as a set against the dark chart surface (#151517): lightness band,
 * chroma floor, adjacent-pair colour-vision separation and 3:1 contrast all pass.
 */
export const CHART_SERIES_COLORS = [
  '#0f9e8f',
  '#d95926',
  '#9085e9',
  '#c98500',
  '#d55181',
  '#3987e5',
] as const;

export const CHART_GRID_COLOR = '#3f3f46';
/** Axis and category text (text token, never a series colour). */
export const CHART_AXIS_TEXT = '#a1a1aa';
/** Direct value labels (primary text token). */
export const CHART_VALUE_TEXT = '#d4d4d8';

export const CHART_TICK_STYLE = { fill: CHART_AXIS_TEXT, fontSize: 12 } as const;

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: '#27272a',
  border: '1px solid #3f3f46',
  borderRadius: '6px',
  color: '#d4d4d8',
  fontSize: '13px',
};

export const CHART_TOOLTIP_ITEM_STYLE: CSSProperties = { color: '#d4d4d8' };

const DEFAULT_CHART_HEIGHT = 260;
const MIN_CHART_HEIGHT = 160;
const MAX_CHART_HEIGHT = 480;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_COLOR = /^(?:rgba?|hsla?)\(\s*[\d.\s,%/+-]+\)$/i;
const NAMED_COLOR = /^[a-z]{3,24}$/i;

/** True for a colour string an agent may request: hex, rgb()/hsl(), or a CSS colour name. */
export function isChartColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const candidate = value.trim();
  if (HEX_COLOR.test(candidate) || FUNCTION_COLOR.test(candidate)) return true;
  if (!NAMED_COLOR.test(candidate)) return false;
  return typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && CSS.supports('color', candidate);
}

/**
 * One colour per series. Requested colours (`colors` first, else `color`)
 * take their slots in order; unrequested slots fall back to the default order.
 */
export function resolveSeriesColors(
  count: number,
  requested: { color?: unknown; colors?: unknown },
): string[] {
  const picked: string[] = Array.isArray(requested.colors)
    ? requested.colors.filter(isChartColor).map((color) => color.trim())
    : [];
  if (picked.length === 0 && isChartColor(requested.color)) {
    picked.push(requested.color.trim());
  }
  return Array.from({ length: Math.max(count, 0) }, (_, index) =>
    picked[index] ?? CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]);
}

/** Honour a requested pixel height within a range that fits the conversation column. */
export function resolveChartHeight(height: unknown, fallback = DEFAULT_CHART_HEIGHT): number {
  if (typeof height !== 'number' || !Number.isFinite(height)) return fallback;
  return Math.round(Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, height)));
}

const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const valueFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** Axis ticks: plain below 1,000, compact from there (1K, 2.5K, 1.2M). */
export function formatAxisNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
  return Math.abs(value) >= 1000 ? compactFormatter.format(value) : valueFormatter.format(value);
}

/** Direct labels and tooltips: full value with grouping. */
export function formatChartValue(value: unknown): string {
  const numeric = toFiniteNumber(value);
  if (numeric !== undefined) return valueFormatter.format(numeric);
  return String(value ?? '');
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

/**
 * Round value-axis ticks (0 / 1K / 2K / 3K) spanning every plotted value and
 * zero. Undefined when the rows carry no numeric spread, so Recharts decides.
 */
export function niceValueTicks(
  rows: ReadonlyArray<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
  intervals = 4,
): number[] | undefined {
  const values = rows.flatMap((row) => keys.map((key) => toFiniteNumber(row[key])))
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (max === min) return undefined;
  const rawStep = (max - min) / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10]
    .map((multiplier) => multiplier * magnitude)
    .find((candidate) => candidate >= rawStep) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const count = Math.round((end - start) / step);
  return Array.from({ length: count + 1 }, (_, index) => Number((start + index * step).toPrecision(12)));
}

/** Shorten long category labels so neighbouring ticks don't collide. */
export function truncateLabel(value: unknown, maxLength: number): string {
  const label = String(value ?? '');
  return label.length > maxLength ? `${label.slice(0, Math.max(1, maxLength - 1))}…` : label;
}
