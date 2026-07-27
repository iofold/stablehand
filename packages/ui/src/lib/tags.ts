/**
 * Parse a human-entered tag list ("team=growth, env=prod") into the tag
 * record the turn-start APIs accept. Returns an error message instead of
 * guessing when an entry is malformed.
 */
export function parseTagsInput(raw: string):
  | { tags: Record<string, string> }
  | { error: string } {
  const tags: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0 || separator === trimmed.length - 1) {
      return { error: `Tag "${trimmed}" must look like key=value` };
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || !value) {
      return { error: `Tag "${trimmed}" must look like key=value` };
    }
    tags[key] = value;
  }
  return { tags };
}

/** System tags stamped by the platform; hidden from tag chips in the UI. */
const SYSTEM_TAG_KEYS = new Set(['agent', 'harness', 'mode']);

export function userVisibleTags(
  tags: Record<string, string> | null | undefined,
): Array<[string, string]> {
  return Object.entries(tags ?? {}).filter(([key]) => !SYSTEM_TAG_KEYS.has(key));
}
