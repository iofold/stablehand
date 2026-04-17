import { describe, expect, it } from 'vitest';

import {
  stringifyJsonWithBigInts,
  toJsonCompatibleValue,
} from '../json-serialization.js';

describe('json-serialization', () => {
  it('serializes nested bigint values as decimal strings', () => {
    const createdAt = new Date('2026-04-14T00:00:00.000Z');

    expect(
      stringifyJsonWithBigInts({
        topLevel: 9007199254740993n,
        nested: [1n, { deep: 2n }],
        createdAt,
      }),
    ).toBe(
      '{"topLevel":"9007199254740993","nested":["1",{"deep":"2"}],"createdAt":"2026-04-14T00:00:00.000Z"}',
    );
  });

  it('converts values into JSON-compatible objects without bigint coercion', () => {
    expect(
      toJsonCompatibleValue({
        next: 9007199254740995n,
        child: {
          count: 3n,
        },
      }),
    ).toEqual({
      next: '9007199254740995',
      child: {
        count: '3',
      },
    });
  });

  it('falls back to JSON null for undefined top-level values', () => {
    expect(stringifyJsonWithBigInts(undefined)).toBe('null');
  });
});
