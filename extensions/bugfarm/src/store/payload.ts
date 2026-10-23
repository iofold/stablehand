import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a partial payload into the previous one. Plain objects merge key by
 * key, at any depth; arrays, strings, numbers and `null` replace what was
 * there. So `{ stage_times: { controls: 1 } }` adds one timestamp, while
 * `{ failing_tests: [...] }` replaces the whole list.
 */
export function mergePayload(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    const prior = out[key];
    out[key] = isPlainObject(prior) && isPlainObject(value) ? mergePayload(prior, value) : value;
  }
  return out;
}

/** JSON with object keys sorted at every depth, so equal payloads hash equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function contentSha(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}
