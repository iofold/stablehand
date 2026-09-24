/**
 * Strip characters that PostgreSQL rejects in text columns.
 * Currently: null bytes (0x00) which cause "invalid byte sequence for encoding UTF8".
 * Logs a warning when stripping occurs — never silently mutate.
 */
export function sanitizeDbText(value: string, context?: string): string {
  if (value.indexOf('\0') === -1) return value;
  const cleaned = value.replace(/\0/g, '');
  console.warn(`[sanitize] Stripped ${value.length - cleaned.length} null byte(s) from DB text${context ? ` (${context})` : ''}`);
  return cleaned;
}

/**
 * Recursively sanitize all string values in a JSON-serializable structure.
 * Handles objects, arrays, and nested strings (for JSONB columns like messages.parts, messages.toolCalls).
 */
export function sanitizeDbValue(value: unknown, context?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeDbText(value, context);
  if (Array.isArray(value)) return value.map((item) => sanitizeDbValue(item, context));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDbValue(v, context);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize JSONB-bound values and coerce BigInt values to decimal strings.
 * This is intentionally separate from sanitizeDbValue so callers opt in where
 * JSON.stringify compatibility is required and lossless BigInt strings are OK.
 */
export function sanitizeDbJsonValue(value: unknown, context?: string): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeDbText(value, context);
  if (Array.isArray(value)) return value.map((item) => sanitizeDbJsonValue(item, context));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDbJsonValue(v, context);
    }
    return out;
  }
  return value;
}
