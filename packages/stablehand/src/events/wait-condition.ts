export function matchesSelector(
  payload: Record<string, unknown>,
  selector: Record<string, unknown>,
): boolean {
  return Object.entries(selector).every(([k, v]) => payload[k] === v);
}
