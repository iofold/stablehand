import { describe, expect, it } from 'vitest';

import { parseRunSpendCapInput, readRunSpendCap, writeRunSpendCap } from '../run-spend-cap';

describe('run spend cap field helpers', () => {
  it('reads the cap from harness config JSON', () => {
    expect(readRunSpendCap('{"model":"m","limits":{"maxCostUsd":0.05}}')).toBe('0.05');
    expect(readRunSpendCap('{"model":"m"}')).toBe('');
    expect(readRunSpendCap('{"model":')).toBeNull();
    expect(readRunSpendCap('[]')).toBeNull();
  });

  it('parses the field as no cap, a positive amount, or invalid', () => {
    expect(parseRunSpendCapInput('  ')).toBeUndefined();
    expect(parseRunSpendCapInput('1.5')).toBe(1.5);
    expect(parseRunSpendCapInput('0')).toBeNull();
    expect(parseRunSpendCapInput('-2')).toBeNull();
    expect(parseRunSpendCapInput('abc')).toBeNull();
  });

  it('writes and removes the cap while keeping the rest of the config', () => {
    const written = writeRunSpendCap('{"model":"m","limits":{"maxModelCalls":5}}', 0.25);
    expect(JSON.parse(written!)).toEqual({ model: 'm', limits: { maxModelCalls: 5, maxCostUsd: 0.25 } });

    const removed = writeRunSpendCap(written!, undefined);
    expect(JSON.parse(removed!)).toEqual({ model: 'm', limits: { maxModelCalls: 5 } });

    expect(JSON.parse(writeRunSpendCap('{"model":"m","limits":{"maxCostUsd":1}}', undefined)!))
      .toEqual({ model: 'm' });
    expect(writeRunSpendCap('not json', 1)).toBeNull();
  });
});
