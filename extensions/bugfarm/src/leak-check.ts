/**
 * Does an issue-style instruction give away the fix?
 *
 * The rule of thumb: anything a user of the library would see is fair game, so names that the
 * hidden tests use (the public API a reproduction needs) are allowed. Anything that only the fix
 * touches is a leak:
 *
 * - `file_path`: a changed source file, by path, basename or dotted module name;
 * - `changed_symbol`: a function or class the fix edits, or a name the fix introduces;
 * - `diff_line`: a line the fix adds or removes, quoted (whitespace-insensitive);
 * - `hidden_test`: a hidden test's file or function name.
 *
 * Deterministic and cheap, so it runs on every Writer submission and once more before packaging.
 */

export type LeakKind = 'file_path' | 'changed_symbol' | 'diff_line' | 'hidden_test';

export interface Leak {
  kind: LeakKind;
  text: string;
  why: string;
}

export interface LeakCheckInput {
  instruction: string;
  /** Unified diff of the fix's source changes (buggy → fixed). */
  fixDiff: string;
  sourceFiles: string[];
  /** Source of the hidden tests (fixed versions); names used here are public. */
  testSource: string;
  /** Hidden test files and fail-to-pass test ids. */
  testFiles: string[];
  failToPass: string[];
}

export interface LeakReport {
  clean: boolean;
  leaks: Leak[];
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const DEF_RE = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const HUNK_RE = /^@@[^@]*@@\s*(.*)$/;
/** Names too generic to count as a giveaway even when the fix touches them. */
const COMMON = new Set([
  'self', 'cls', 'None', 'True', 'False', 'return', 'import', 'from', 'class', 'def', 'async', 'await',
  'value', 'values', 'result', 'data', 'name', 'type', 'args', 'kwargs', 'item', 'items', 'key', 'keys',
  'field', 'fields', 'model', 'request', 'response', 'error', 'errors', 'default', 'config', 'params',
  'str', 'int', 'bool', 'list', 'dict', 'tuple', 'set', 'Any', 'Optional', 'Union', 'isinstance',
  'len', 'get', 'run', 'call', 'init', '__init__', '__call__', 'main', 'test',
]);

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function words(text: string): Set<string> {
  return new Set(text.match(IDENT_RE) ?? []);
}

function mentions(instruction: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(instruction);
}

interface DiffFacts {
  changedSymbols: Set<string>;
  added: string[];
  removed: string[];
}

export function diffFacts(diff: string): DiffFacts {
  const changedSymbols = new Set<string>();
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      const def = DEF_RE.exec(hunk[1]);
      if (def) changedSymbols.add(def[1]);
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      const body = line.slice(1);
      const def = DEF_RE.exec(body);
      if (def) changedSymbols.add(def[1]);
      (line.startsWith('+') ? added : removed).push(body);
    }
  }
  return { changedSymbols, added, removed };
}

/** A quoted diff line only counts when it is code-like and long enough to be specific. */
function quotable(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 16) return false;
  if (trimmed.startsWith('#') || trimmed.startsWith('"""') || trimmed.startsWith("'''")) return false;
  return /[()=.[\]:]/.test(trimmed);
}

function isDistinctive(name: string): boolean {
  if (COMMON.has(name) || name.length < 4) return false;
  return name.startsWith('_') || name.includes('_') || /[a-z][A-Z]/.test(name) || name.length >= 8;
}

export function checkLeaks(input: LeakCheckInput): LeakReport {
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  const add = (leak: Leak) => {
    const key = `${leak.kind}:${leak.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    leaks.push(leak);
  };
  const text = input.instruction;
  const lower = text.toLowerCase();
  const publicNames = words(input.testSource);

  for (const file of input.sourceFiles) {
    const base = file.split('/').pop() ?? file;
    const dotted = file.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').split('/').join('.');
    if (lower.includes(file.toLowerCase())) add({ kind: 'file_path', text: file, why: 'names the file the fix changes' });
    else if (base !== '__init__.py' && mentions(text, base)) add({ kind: 'file_path', text: base, why: 'names the file the fix changes' });
    if (dotted.includes('.') && mentions(text, dotted) && !input.testSource.includes(dotted)) {
      add({ kind: 'file_path', text: dotted, why: 'names the module the fix changes, which the tests never import' });
    }
  }

  const facts = diffFacts(input.fixDiff);
  for (const name of facts.changedSymbols) {
    if (COMMON.has(name) || name.length < 3) continue;
    if (publicNames.has(name) && !name.startsWith('_')) continue;
    if (mentions(text, name)) add({ kind: 'changed_symbol', text: name, why: 'names a function or class the fix edits' });
  }

  // Names the fix introduces (in added lines only) that a user would never see.
  const removedWords = words(facts.removed.join('\n'));
  for (const name of words(facts.added.join('\n'))) {
    if (removedWords.has(name) || publicNames.has(name) || !isDistinctive(name)) continue;
    if (mentions(text, name)) add({ kind: 'changed_symbol', text: name, why: 'names something the fix introduces' });
  }

  const normalized = normalize(text);
  for (const line of [...facts.added, ...facts.removed]) {
    if (!quotable(line)) continue;
    const needle = normalize(line);
    if (normalized.includes(needle)) add({ kind: 'diff_line', text: line.trim().slice(0, 160), why: 'quotes a line the fix adds or removes' });
  }

  for (const file of input.testFiles) {
    const base = file.split('/').pop() ?? file;
    if (lower.includes(file.toLowerCase()) || mentions(text, base)) add({ kind: 'hidden_test', text: base, why: 'names a hidden test file' });
  }
  for (const id of input.failToPass) {
    const fn = id.split('::').pop()?.replace(/\[.*$/, '');
    if (fn && fn.startsWith('test') && fn.length > 5 && mentions(text, fn)) add({ kind: 'hidden_test', text: fn, why: 'names a hidden test' });
  }

  return { clean: leaks.length === 0, leaks };
}

/** One line per leak, for a tool response or a rewrite prompt. */
export function describeLeaks(report: LeakReport): string {
  if (report.clean) return 'No leaks found.';
  return report.leaks.map((leak) => `- ${leak.kind}: "${leak.text}" (${leak.why})`).join('\n');
}
