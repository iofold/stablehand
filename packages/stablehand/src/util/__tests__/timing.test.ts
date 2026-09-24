import { describe, expect, it, vi } from 'vitest';

import { parsePositiveMs, unrefTimer } from '../timing.js';

describe('timing utilities', () => {
  it.each([
    [42, 42],
    ['250', 250],
    [0, undefined],
    [-1, undefined],
    ['invalid', undefined],
    [undefined, undefined],
    [null, undefined],
  ])('parses positive millisecond values from %j', (value, expected) => {
    expect(parsePositiveMs(value)).toBe(expected);
  });

  it('unrefs Node timers when the method is available', () => {
    const timer = { unref: vi.fn() };

    unrefTimer(timer as unknown as ReturnType<typeof setTimeout>);

    expect(timer.unref).toHaveBeenCalledOnce();
  });
});
