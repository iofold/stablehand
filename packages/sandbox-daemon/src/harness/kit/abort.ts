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

export function linkTurnAbort(
  configSignal: AbortSignal | undefined,
  contextSignal: AbortSignal | undefined,
  abort: () => void,
): () => void {
  const unlinkConfig = linkAbortSignal(configSignal, abort);
  const unlinkContext = linkAbortSignal(contextSignal, abort);
  return () => {
    unlinkConfig();
    unlinkContext();
  };
}
