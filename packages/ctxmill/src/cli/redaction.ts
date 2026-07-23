type JsonRecord = Record<string, unknown>;

const SECRET_KEY_RE =
  /(secret|token|password|authorization|api[_-]?key|credential|private[_-]?key)/i;

const USAGE_TOKEN_KEY_RE =
  /^(?:(?:input|output|total|prompt|completion|reasoning|cached?|cache(?:read|write|create|creation)(?:input)?|audio|acceptedprediction|rejectedprediction|servertooluse|billable)(?:tokens?|tokencount|tokenscount|tokensused|tokendetails|tokensdetails)|tokenusage|tokencount|tokensused|tokenreportedturncount)$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  if (!SECRET_KEY_RE.test(key)) {
    return false;
  }
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  return !USAGE_TOKEN_KEY_RE.test(normalized);
}

export function redactSensitiveFields(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, seen));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  const redacted: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactSensitiveFields(child, seen);
  }
  return redacted;
}
