/**
 * The agent form edits the per-run spend cap as its own field, but the value
 * lives in the harness config JSON (`limits.maxCostUsd`), the same place the
 * YAML manifest and the API carry it. These helpers keep the two in step.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The cap in the harness config text as an input string; null when the JSON is not an object. */
export function readRunSpendCap(harnessConfigText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(harnessConfigText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const limits = parsed.limits;
  if (!isRecord(limits)) return '';
  const value = limits.maxCostUsd;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** Parse the field: undefined for "no cap", a positive number, or null when invalid. */
export function parseRunSpendCapInput(input: string): number | undefined | null {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Write the cap into the harness config text, preserving every other field.
 * Returns null when the JSON cannot be edited (invalid or not an object).
 */
export function writeRunSpendCap(harnessConfigText: string, capUsd: number | undefined): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(harnessConfigText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const limits = isRecord(parsed.limits) ? { ...parsed.limits } : {};
  if (capUsd === undefined) {
    delete limits.maxCostUsd;
  } else {
    limits.maxCostUsd = capUsd;
  }
  const next: Record<string, unknown> = { ...parsed };
  if (Object.keys(limits).length > 0) {
    next.limits = limits;
  } else {
    delete next.limits;
  }
  return JSON.stringify(next, null, 2);
}
