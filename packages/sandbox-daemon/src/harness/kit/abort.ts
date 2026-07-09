export function linkAbortSignal(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    abort();
    return () => {};
  }

  const onAbort = () => abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}
