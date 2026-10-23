/**
 * Budget-attribution tag rules shared by every path that puts tags on a turn:
 * the turn-start APIs, trigger definitions, and tags a triggered turn inherits
 * from the event that fired it.
 */

/** Keys the runtime stamps on every turn; callers can never set them. */
export const RESERVED_TAG_KEYS: ReadonlySet<string> = new Set(['agent', 'harness', 'mode']);

/** Longest accepted tag value, in characters. */
export const MAX_TAG_VALUE_LENGTH = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidTagValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_VALUE_LENGTH;
}

/**
 * Validate caller-supplied tags. Throws an `Error` whose message names the
 * offending field; returns undefined for an absent or empty map.
 */
export function parseTagsInput(value: unknown, field = 'tags'): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be an object of string values`);
  }
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw new Error(`${field} keys must be non-empty`);
    }
    if (RESERVED_TAG_KEYS.has(key)) {
      throw new Error(`${field}.${key} is reserved (stamped by the system)`);
    }
    if (!isValidTagValue(tagValue)) {
      throw new Error(`${field}.${key} must be a non-empty string (max ${MAX_TAG_VALUE_LENGTH} chars)`);
    }
    tags[key] = tagValue;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

/**
 * Lenient form for tags carried by events and stored turns: keeps only the
 * entries `parseTagsInput` would accept and drops the rest (reserved system
 * keys included), so a malformed event never blocks the trigger it fires.
 */
export function pickValidTags(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (key.trim().length === 0 || RESERVED_TAG_KEYS.has(key)) continue;
    if (!isValidTagValue(tagValue)) continue;
    tags[key] = tagValue;
  }
  return tags;
}
