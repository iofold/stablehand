export function parsePositiveMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function unrefTimer(
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>,
): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}
