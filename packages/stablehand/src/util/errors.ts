/**
 * Extract a human-readable message from an unknown caught value.
 * Replaces the scattered `err instanceof Error ? err.message : String(err)` pattern.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Check if an error has an HTTP status code matching any in the given list.
 * Used for retry logic — don't retry 400/401/403.
 */
export function isHttpError(err: unknown, statuses: number[]): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: number }).status;
  return typeof status === 'number' && statuses.includes(status);
}
