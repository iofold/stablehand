import { describe, expect, it } from 'vitest';
import {
  CHART_SERIES_COLORS,
  formatAxisNumber,
  formatChartValue,
  isChartColor,
  niceValueTicks,
  resolveChartHeight,
  resolveSeriesColors,
  truncateLabel,
} from './chart-style';

describe('chart-style', () => {
  it('accepts hex and functional colours and rejects markup', () => {
    expect(isChartColor('#6F4E37')).toBe(true);
    expect(isChartColor('#abc')).toBe(true);
    expect(isChartColor('rgb(10, 20, 30)')).toBe(true);
    expect(isChartColor('hsl(200 50% 40%)')).toBe(true);
    expect(isChartColor('#12')).toBe(false);
    expect(isChartColor('url(javascript:alert(1))')).toBe(false);
    expect(isChartColor('"><script>')).toBe(false);
    expect(isChartColor(42)).toBe(false);
  });

  it('gives the requested colour to the first series and defaults to the rest', () => {
    expect(resolveSeriesColors(1, { color: '#6F4E37' })).toEqual(['#6F4E37']);
    expect(resolveSeriesColors(2, { color: '#6F4E37' })).toEqual(['#6F4E37', CHART_SERIES_COLORS[1]]);
    expect(resolveSeriesColors(2, { colors: ['#111111', 'nope('], color: '#222222' }))
      .toEqual(['#111111', CHART_SERIES_COLORS[1]]);
    expect(resolveSeriesColors(1, {})).toEqual([CHART_SERIES_COLORS[0]]);
  });

  it('honours a requested height inside the conversation-column range', () => {
    expect(resolveChartHeight(320)).toBe(320);
    expect(resolveChartHeight(40)).toBe(160);
    expect(resolveChartHeight(2000)).toBe(480);
    expect(resolveChartHeight('tall')).toBe(260);
  });

  it('formats axis ticks compactly and labels in full', () => {
    expect(formatAxisNumber(2600)).toBe('2.6K');
    expect(formatAxisNumber(600)).toBe('600');
    expect(formatChartValue(2600)).toBe('2,600');
    expect(formatChartValue('1850')).toBe('1,850');
    expect(formatChartValue('July')).toBe('July');
  });

  it('picks round value-axis ticks that include zero and the largest value', () => {
    const rows = [{ m: 'Jul', v: 1200 }, { m: 'Aug', v: 1850 }, { m: 'Sep', v: 2600 }];
    expect(niceValueTicks(rows, ['v'])).toEqual([0, 1000, 2000, 3000]);
    expect(niceValueTicks([{ v: -3 }, { v: 7 }], ['v'])).toEqual([-5, -2.5, 0, 2.5, 5, 7.5]);
    expect(niceValueTicks([{ v: 'n/a' }], ['v'])).toBeUndefined();
    expect(niceValueTicks([{ v: 0 }], ['v'])).toBeUndefined();
  });

  it('truncates long category labels', () => {
    expect(truncateLabel('September', 12)).toBe('September');
    expect(truncateLabel('A very long category name', 12)).toBe('A very long…');
  });
});
