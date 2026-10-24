/**
 * The predicate language of deterministic Scout filters, shared by the worker (which applies
 * them) and the board (which shows them).
 *
 * A Scout filter's `skip_if` is a predicate over a candidate's features: the worker drops every
 * candidate the Scout submits that it matches, before the candidate becomes a card. A predicate
 * is plain JSON:
 *
 *   {"field": "age_days", "op": ">", "value": 300}
 *   {"all": [ ... ]}   {"any": [ ... ]}   {"not": { ... }}
 *
 * A leaf whose feature is unknown is neither true nor false, and a filter only skips a candidate
 * when its predicate is certainly true, so missing data never drops a candidate.
 */

export type FeatureType = 'number' | 'string' | 'strings' | 'boolean';

export interface FeatureField {
  type: FeatureType;
  description: string;
}

/** Every feature a predicate may name. The worker computes them from git and the Scout's text. */
export const FEATURE_FIELDS = {
  age_days: { type: 'number', description: 'Days from the fix to the repository HEAD the campaign runs on' },
  fix_date: { type: 'string', description: 'When the fix was committed (ISO-8601)' },
  files: { type: 'number', description: 'Files the fix changes, docs excluded (source, tests and other)' },
  source_file_count: { type: 'number', description: 'Package source files it changes' },
  test_file_count: { type: 'number', description: 'Test files it changes' },
  source_files: { type: 'strings', description: 'Package source files it changes (repo paths)' },
  test_files: { type: 'strings', description: 'Test files it changes (repo paths)' },
  other_files: { type: 'strings', description: 'Files that are neither source, tests nor docs' },
  non_test_lines: { type: 'number', description: 'Lines added plus deleted outside tests and docs' },
  lines_added: { type: 'number', description: 'Lines added outside tests and docs' },
  lines_deleted: { type: 'number', description: 'Lines deleted outside tests and docs' },
  test_lines: { type: 'number', description: 'Lines added plus deleted in test files' },
  title: { type: 'string', description: 'Pull request title as written, emoji included' },
  title_prefix: { type: 'string', description: 'Leading emoji or :code: of the title, empty when there is none' },
  labels: { type: 'strings', description: 'Pull request labels' },
  has_issue: { type: 'boolean', description: 'The pull request closes an issue' },
  pr_body_chars: { type: 'number', description: 'Length of the pull request description' },
  issue_body_chars: { type: 'number', description: 'Length of the closed issue text, 0 when none' },
  scout_rank: { type: 'number', description: "Position in the Scout's ranked list, 1 = its first pick" },
} as const satisfies Record<string, FeatureField>;

export type FeatureName = keyof typeof FEATURE_FIELDS;

export type FeatureValue = number | string | boolean | string[] | null;

export type CandidateFeatures = Partial<Record<FeatureName, FeatureValue>>;

export const NUMBER_OPS = ['<', '<=', '>', '>=', '==', '!='] as const;
export const STRING_OPS = ['==', '!=', 'matches', 'contains'] as const;
export const STRINGS_OPS = ['contains', 'any_matches', 'all_match', 'none_match'] as const;
export const BOOLEAN_OPS = ['==', '!='] as const;

/** Ops whose value is a regular expression (matched case-insensitively). */
const REGEX_OPS: ReadonlySet<string> = new Set(['matches', 'any_matches', 'all_match', 'none_match']);

export const OPS_BY_TYPE: Record<FeatureType, readonly string[]> = {
  number: NUMBER_OPS,
  string: STRING_OPS,
  strings: STRINGS_OPS,
  boolean: BOOLEAN_OPS,
};

export interface PredicateLeaf {
  field: string;
  op: string;
  value: unknown;
}

export type Predicate = { all: Predicate[] } | { any: Predicate[] } | { not: Predicate } | PredicateLeaf;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isLeaf(pred: Predicate): pred is PredicateLeaf {
  return isObject(pred) && typeof (pred as unknown as PredicateLeaf).field === 'string';
}

function regex(pattern: unknown): RegExp | null {
  if (typeof pattern !== 'string') return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/** One leaf: true, false, or null when the feature is unknown or the leaf is malformed. */
function leaf(pred: PredicateLeaf, features: CandidateFeatures): boolean | null {
  const field = FEATURE_FIELDS[pred.field as FeatureName] as FeatureField | undefined;
  if (!field) return null;
  const actual = features[pred.field as FeatureName];
  if (actual === undefined || actual === null) return null;
  const { op, value } = pred;
  switch (field.type) {
    case 'number': {
      if (typeof actual !== 'number' || typeof value !== 'number') return null;
      if (op === '<') return actual < value;
      if (op === '<=') return actual <= value;
      if (op === '>') return actual > value;
      if (op === '>=') return actual >= value;
      if (op === '==') return actual === value;
      if (op === '!=') return actual !== value;
      return null;
    }
    case 'boolean': {
      if (typeof actual !== 'boolean' || typeof value !== 'boolean') return null;
      if (op === '==') return actual === value;
      if (op === '!=') return actual !== value;
      return null;
    }
    case 'string': {
      if (typeof actual !== 'string' || typeof value !== 'string') return null;
      if (op === '==') return actual.toLowerCase() === value.toLowerCase();
      if (op === '!=') return actual.toLowerCase() !== value.toLowerCase();
      if (op === 'contains') return actual.toLowerCase().includes(value.toLowerCase());
      if (op === 'matches') {
        const re = regex(value);
        return re ? re.test(actual) : null;
      }
      return null;
    }
    case 'strings': {
      if (!Array.isArray(actual) || typeof value !== 'string') return null;
      if (op === 'contains') return actual.some((entry) => entry.toLowerCase() === value.toLowerCase());
      const re = regex(value);
      if (!re) return null;
      if (op === 'any_matches') return actual.some((entry) => re.test(entry));
      if (op === 'none_match') return !actual.some((entry) => re.test(entry));
      if (op === 'all_match') return actual.length > 0 && actual.every((entry) => re.test(entry));
      return null;
    }
    default:
      return null;
  }
}

/** Three-valued evaluation: null means "cannot tell" (a feature is missing). */
export function evaluatePredicate(pred: Predicate, features: CandidateFeatures): boolean | null {
  if (!isObject(pred)) return null;
  if ('all' in pred && Array.isArray(pred.all)) {
    let unknown = false;
    for (const part of pred.all) {
      const v = evaluatePredicate(part, features);
      if (v === false) return false;
      if (v === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ('any' in pred && Array.isArray(pred.any)) {
    let unknown = false;
    for (const part of pred.any) {
      const v = evaluatePredicate(part, features);
      if (v === true) return true;
      if (v === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ('not' in pred) {
    const v = evaluatePredicate(pred.not, features);
    return v === null ? null : !v;
  }
  if (isLeaf(pred)) return leaf(pred, features);
  return null;
}

/** True only when the predicate certainly matches: the filter skips the candidate. */
export function matches(pred: Predicate, features: CandidateFeatures): boolean {
  return evaluatePredicate(pred, features) === true;
}

/** Structural problems, for the Teacher's tool: unknown fields, wrong ops, bad values, bad regexes. */
export function predicateProblems(pred: unknown, path = 'skip_if', depth = 0, counter = { leaves: 0 }): string[] {
  if (depth > 4) return [`${path}: nested deeper than 4 levels`];
  if (!isObject(pred)) return [`${path}: expected an object`];
  const keys = Object.keys(pred);
  if ('all' in pred || 'any' in pred) {
    const key = 'all' in pred ? 'all' : 'any';
    const list = pred[key];
    if (keys.length !== 1) return [`${path}: "${key}" must be the only key`];
    if (!Array.isArray(list) || list.length === 0 || list.length > 6) return [`${path}.${key}: expected 1 to 6 predicates`];
    return list.flatMap((part, i) => predicateProblems(part, `${path}.${key}[${i}]`, depth + 1, counter));
  }
  if ('not' in pred) {
    if (keys.length !== 1) return [`${path}: "not" must be the only key`];
    return predicateProblems(pred.not, `${path}.not`, depth + 1, counter);
  }
  counter.leaves += 1;
  if (counter.leaves > 8) return [`${path}: more than 8 conditions in one filter`];
  const extra = keys.filter((key) => !['field', 'op', 'value'].includes(key));
  if (extra.length > 0) return [`${path}: unexpected keys ${extra.join(', ')} (a condition has field, op and value)`];
  const field = FEATURE_FIELDS[pred.field as FeatureName] as FeatureField | undefined;
  if (!field) return [`${path}.field: unknown feature "${String(pred.field)}"; known: ${Object.keys(FEATURE_FIELDS).join(', ')}`];
  const ops = OPS_BY_TYPE[field.type];
  if (typeof pred.op !== 'string' || !ops.includes(pred.op)) return [`${path}.op: ${String(pred.field)} is a ${field.type}; op must be one of ${ops.join(' ')}`];
  const value = pred.value;
  if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return [`${path}.value: expected a number`];
  if (field.type === 'boolean' && typeof value !== 'boolean') return [`${path}.value: expected true or false`];
  if (field.type === 'string' || field.type === 'strings') {
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) return [`${path}.value: expected a string of 1 to 200 characters`];
    if (REGEX_OPS.has(pred.op) && !regex(value)) return [`${path}.value: not a valid regular expression`];
  }
  return [];
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** One line a person can read: `age_days > 300 and (title matches "v1" or labels contains "docs")`. */
export function describePredicate(pred: Predicate, nested = false): string {
  if (!isObject(pred)) return '?';
  if ('all' in pred && Array.isArray(pred.all)) {
    const text = pred.all.map((part) => describePredicate(part, true)).join(' and ');
    return nested && pred.all.length > 1 ? `(${text})` : text;
  }
  if ('any' in pred && Array.isArray(pred.any)) {
    const text = pred.any.map((part) => describePredicate(part, true)).join(' or ');
    return nested && pred.any.length > 1 ? `(${text})` : text;
  }
  if ('not' in pred) return `not ${describePredicate(pred.not, true)}`;
  if (isLeaf(pred)) {
    const op = pred.op.replace(/_/g, ' ');
    return `${pred.field} ${op} ${describeValue(pred.value)}`;
  }
  return '?';
}
