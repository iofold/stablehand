const UNIQUE_VIOLATION_CODE = '23505';
const FOREIGN_KEY_VIOLATION_CODE = '23503';
const MAX_CAUSE_DEPTH = 5;

/**
 * Drizzle >=0.44 wraps driver errors in DrizzleQueryError, so the postgres
 * error (with `code`/`constraint_name`) lives on the cause chain rather than
 * the thrown error itself.
 */
function* causeChain(err: unknown): Generator<unknown> {
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    yield current;
    if (typeof current !== 'object' || !('cause' in current)) {
      return;
    }
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * True when the error (or any error on its cause chain) is a postgres unique
 * constraint violation. When `constraintName` is given, the violation must
 * reference that constraint/index.
 */
export function isUniqueConstraintViolation(err: unknown, constraintName?: string): boolean {
  for (const level of causeChain(err)) {
    if (typeof level !== 'object' || level === null) {
      continue;
    }
    const record = level as { code?: unknown; constraint_name?: unknown; constraint?: unknown; message?: unknown };
    if (record.code !== UNIQUE_VIOLATION_CODE) {
      continue;
    }
    if (constraintName === undefined) {
      return true;
    }
    if (
      record.constraint_name === constraintName
      || record.constraint === constraintName
      || (typeof record.message === 'string' && record.message.includes(constraintName))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when the error (or any error on its cause chain) is a postgres foreign
 * key violation, e.g. a child insert racing a cascade delete of its parent.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  for (const level of causeChain(err)) {
    if (typeof level === 'object' && level !== null
      && (level as { code?: unknown }).code === FOREIGN_KEY_VIOLATION_CODE) {
      return true;
    }
  }
  return false;
}
