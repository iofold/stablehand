import { describe, expect, it } from 'vitest';
import { makeIterableAbortable } from '../abort-iterator.js';

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

async function* finite<T>(...items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function* hang(): AsyncGenerator<never> {
  await new Promise<never>(() => { /* never resolves */ });
  // unreachable — satisfies return type
  yield undefined as never;
}

describe('makeIterableAbortable', () => {
  it('passes through all values when signal is undefined', async () => {
    const result = await collect(makeIterableAbortable(finite(1, 2, 3), undefined));
    expect(result).toEqual([1, 2, 3]);
  });

  it('passes through all values when signal is not aborted', async () => {
    const ac = new AbortController();
    const result = await collect(makeIterableAbortable(finite('a', 'b'), ac.signal));
    expect(result).toEqual(['a', 'b']);
  });

  it('throws AbortError if signal is already aborted before first iteration', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(collect(makeIterableAbortable(finite(1, 2, 3), ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('throws AbortError mid-iteration when signal is aborted while iterator is hanging', async () => {
    const ac = new AbortController();
    // Abort after a short delay while the iterator is blocked
    setTimeout(() => ac.abort(), 20);
    await expect(collect(makeIterableAbortable(hang(), ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('yields values before abort and stops when signal fires mid-stream', async () => {
    const ac = new AbortController();
    const seen: number[] = [];
    async function* slowItems(): AsyncGenerator<number> {
      yield 1;
      yield 2;
      // hangs forever after yielding two values — simulates blocked LLM call
      await new Promise<never>(() => {});
      yield 3 as never;
    }
    // Abort after 20ms so we receive the first two items then get cut off
    setTimeout(() => ac.abort(), 20);
    await expect(
      (async () => {
        for await (const v of makeIterableAbortable(slowItems(), ac.signal)) {
          seen.push(v);
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([1, 2]);
  });
});
