import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  formatDurationBetween,
  formatEventDuration,
  formatEventTime,
  formatRelativeTime,
  formatRunningDuration,
  formatTimeUntil,
  formatTimestamp,
  formatTimestampInZone,
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

  it('says how long until a future time', () => {
    const now = Date.parse('2026-10-23T05:00:00Z');
    expect(formatTimeUntil(now + 20_000, now)).toBe('in under a minute');
    expect(formatTimeUntil(now + 5 * 60_000, now)).toBe('in 5m');
    expect(formatTimeUntil(now + 3 * 3_600_000, now)).toBe('in 3h');
    expect(formatTimeUntil(now + 50 * 3_600_000, now)).toBe('in 2d');
  });

  it('shows a time in the schedule\'s own zone and names the zone', () => {
    const at = Date.parse('2026-10-26T01:30:00Z');
    const kolkata = formatTimestampInZone(at, 'Asia/Kolkata');
    expect(kolkata).toContain('07:00');
    expect(kolkata).toMatch(/GMT\+5:30|IST/);
    expect(formatTimestampInZone(at, 'UTC')).toContain('01:30');
    expect(formatTimestampInZone(at, 'Not/AZone')).toMatch(/\d{2}:\d{2}/);
  });
});
