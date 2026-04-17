// Wraps an AsyncIterable with abort-signal awareness.
// Needed for iterables that have no built-in abort support (e.g. deepagents streamEvents).
export async function* makeIterableAbortable<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T> {
  if (!signal) {
    yield* iterable;
    return;
  }
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    // Build a fresh abort promise each iteration so the listener is always active.
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) {
        abortListener();
        return;
      }
      signal.addEventListener('abort', abortListener, { once: true });
    });

    let result: IteratorResult<T>;
    try {
      result = await Promise.race([iterator.next(), abortPromise]);
    } finally {
      // Remove the listener so it can't fire after the race settles.
      if (abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }

    if (result.done) return;
    yield result.value;
  }
  // Note: iterator.return() is intentionally not called on abort — calling it on a
  // generator blocked on a never-resolving promise would itself hang forever.
}
