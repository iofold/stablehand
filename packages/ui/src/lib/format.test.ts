import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  formatDurationBetween,
  formatEventDuration,
  formatEventTime,
  formatRelativeTime,
  formatRunningDuration,
  formatTimestamp,
} from './format';

describe('format helpers', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps timestamp and elapsed-duration formats distinct', () => {
    expect(formatTimestamp(0)).toBe('--');
    expect(formatDurationBetween(0, 65_000)).toBe('1m 5s');
    expect(formatEventDuration(65_000)).toBe('65s');
    expect(formatEventDuration(950)).toBe('950ms');
  });

  it('preserves dashboard and event relative-time semantics', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T05:00:00Z'));

    expect(formatRunningDuration(Date.now() - 65_000)).toBe('1m 5s');
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('just now');
    expect(formatEventTime(Date.now() - 30_000)).toBe('30s ago');
  });

  it('formats artifact bytes with the established units', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
