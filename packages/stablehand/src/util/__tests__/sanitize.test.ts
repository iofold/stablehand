import { describe, it, expect, vi, afterEach } from 'vitest';

import { sanitizeDbJsonValue, sanitizeDbText, sanitizeDbValue } from '../sanitize.js';

describe('sanitizeDbText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes clean strings through unchanged', () => {
    expect(sanitizeDbText('hello world')).toBe('hello world');
  });

  it('strips null bytes and logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(sanitizeDbText('ab\0cd\0', 'messages.content')).toBe('abcd');
    expect(warnSpy).toHaveBeenCalledWith(
      '[sanitize] Stripped 2 null byte(s) from DB text (messages.content)',
    );
  });

  it('handles empty string', () => {
    expect(sanitizeDbText('')).toBe('');
  });
});

describe('sanitizeDbValue', () => {
  it('recurses into objects', () => {
    expect(sanitizeDbValue({ content: 'he\0llo' })).toEqual({ content: 'hello' });
  });

  it('recurses into arrays', () => {
    expect(sanitizeDbValue(['a\0', 'b', { nested: 'c\0' }])).toEqual(['a', 'b', { nested: 'c' }]);
  });

  it('handles nested objects with null bytes in string values', () => {
    expect(sanitizeDbValue({ nested: { value: 'a\0b', list: ['x\0y'] } })).toEqual({
      nested: { value: 'ab', list: ['xy'] },
    });
  });

  it('passes non-string primitives unchanged', () => {
    expect(sanitizeDbValue(42)).toBe(42);
    expect(sanitizeDbValue(true)).toBe(true);
    expect(sanitizeDbValue(false)).toBe(false);
  });

  it('handles null and undefined', () => {
    expect(sanitizeDbValue(null)).toBeNull();
    expect(sanitizeDbValue(undefined)).toBeUndefined();
  });
});

describe('sanitizeDbJsonValue', () => {
  it('coerces nested bigint values to decimal strings', () => {
    expect(sanitizeDbJsonValue({
      cursor: { nextMessageSeq: 9007199254740993n },
      values: [1n, { nested: 2n }],
    })).toEqual({
      cursor: { nextMessageSeq: '9007199254740993' },
      values: ['1', { nested: '2' }],
    });
  });

  it('still strips null bytes from nested strings', () => {
    expect(sanitizeDbJsonValue({ value: 'a\0b' })).toEqual({ value: 'ab' });
  });
});
