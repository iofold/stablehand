export interface RetryOptions {
  delays: number[];
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { delays, shouldRetry, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (shouldRetry && !shouldRetry(err)) {
        throw err;
      }

      if (attempt < delays.length) {
        const delayMs = delays[attempt];
        onRetry?.(err, attempt, delayMs);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
}
