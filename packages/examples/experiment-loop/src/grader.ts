import { evaluateFormula, FormulaRejected, SpreadsheetError, type Cell } from './formula.js';
import type { ExtractionTask, FormulaTask, Task } from './tasks.js';

export interface Check {
  name: string;
  ok: boolean;
  expected: unknown;
  got: unknown;
  note?: string;
}

export interface Grade {
  taskId: string;
  /** Share of checks passed, 0 to 1. */
  score: number;
  checks: Check[];
  /** Set when the answer could not be graded at all (no JSON, no formula). */
  error?: string;
  /** The formula the grader ran, for formula tasks. */
  formula?: string;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const normalizeText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

function findBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The first JSON object in an answer, inside a code fence or bare. */
export function extractJsonObject(answer: string): Record<string, unknown> | null {
  for (const match of answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = parseObject(match[1] ?? '');
    if (parsed) return parsed;
  }
  for (let start = answer.indexOf('{'); start >= 0; start = answer.indexOf('{', start + 1)) {
    const candidate = findBalancedObject(answer, start);
    const parsed = candidate ? parseObject(candidate) : null;
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The first formula in an answer: a line or inline code span starting with
 * "=", or a JSON string value starting with "=". The grader is lenient about
 * the wrapping and strict about the formula itself.
 */
export function extractFormula(answer: string): string | null {
  const fenced = [...answer.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? '');
  for (const block of [...fenced, answer]) {
    for (const raw of block.split('\n')) {
      const line = raw.trim().replace(/^`+|`+$/g, '').trim();
      if (line.startsWith('=') && line.length > 1) return line;
    }
  }
  const inline = /`(=[^`\n]+)`/.exec(answer);
  if (inline?.[1]) return inline[1].trim();
  const object = extractJsonObject(answer);
  const value = object ? Object.values(object).find((entry) => typeof entry === 'string' && entry.trim().startsWith('=')) : undefined;
  return typeof value === 'string' ? value.trim() : null;
}

function checkValue(name: string, expected: unknown, got: unknown): Check {
  const check = (ok: boolean, note?: string): Check => ({ name, ok, expected, got, ...(note ? { note } : {}) });
  if (got === undefined) return check(false, 'missing from the answer');
  if (expected === null) return check(got === null, got === null ? undefined : 'the document does not give this value');
  if (typeof expected === 'number') {
    if (typeof got === 'string') return check(false, 'given as text, expected a number');
    return check(typeof got === 'number' && close(got, expected));
  }
  if (typeof expected === 'boolean') return check(got === expected);
  if (typeof expected === 'string') {
    if (typeof got === 'number') return check(false, 'given as a number, expected text');
    return check(typeof got === 'string' && normalizeText(got) === normalizeText(expected));
  }
  return check(false, 'unsupported expected value');
}

function gradeExtraction(task: ExtractionTask, answer: string): Grade {
  const object = extractJsonObject(answer);
  if (!object) {
    return {
      taskId: task.id,
      score: 0,
      checks: Object.keys(task.fields).map((name) => ({ name, ok: false, expected: task.expected[name], got: undefined })),
      error: 'no JSON object in the answer',
    };
  }
  const checks = Object.keys(task.fields).map((name) => checkValue(
    name,
    task.expected[name],
    Object.prototype.hasOwnProperty.call(object, name) ? object[name] : undefined,
  ));
  return { taskId: task.id, score: checks.filter((c) => c.ok).length / checks.length, checks };
}

function cellMatches(expected: Cell, got: Cell): boolean {
  if (typeof expected === 'number') return typeof got === 'number' && close(got, expected);
  if (typeof expected === 'string') return typeof got === 'string' && normalizeText(got) === normalizeText(expected);
  return got === expected;
}

function gradeFormula(task: FormulaTask, answer: string): Grade {
  const formula = extractFormula(answer);
  const expectedRows = task.fillDownRows ? task.expected as Cell[] : [task.expected as Cell];
  const targetCell = (offset: number): string => {
    const match = /cell ([A-Z]+)(\d+)/.exec(task.question);
    return match ? `${match[1]}${Number(match[2]) + offset}` : `row ${offset + 2}`;
  };
  if (!formula) {
    return {
      taskId: task.id,
      score: 0,
      checks: expectedRows.map((expected, i) => ({ name: targetCell(i), ok: false, expected, got: undefined })),
      error: 'no formula in the answer (a formula starts with =)',
    };
  }
  const checks: Check[] = [];
  for (let offset = 0; offset < expectedRows.length; offset += 1) {
    const expected = expectedRows[offset] ?? null;
    try {
      const got = evaluateFormula(formula, task.table, { rowOffset: offset });
      checks.push({ name: targetCell(offset), ok: cellMatches(expected, got), expected, got });
    } catch (error) {
      if (error instanceof FormulaRejected) {
        return {
          taskId: task.id,
          score: 0,
          formula,
          checks: expectedRows.map((value, i) => ({ name: targetCell(i), ok: false, expected: value, got: undefined, note: error.message })),
          error: `formula rejected: ${error.message}`,
        };
      }
      if (!(error instanceof SpreadsheetError)) throw error;
      checks.push({ name: targetCell(offset), ok: false, expected, got: error.code, note: error.message });
    }
  }
  return { taskId: task.id, score: checks.filter((c) => c.ok).length / checks.length, checks, formula };
}

export function gradeAnswer(task: Task, answer: string): Grade {
  return task.kind === 'extraction' ? gradeExtraction(task, answer) : gradeFormula(task, answer);
}

function show(value: unknown): string {
  return value === undefined ? '(nothing)' : JSON.stringify(value);
}

/** One line per failed check, for the proposer and the iteration report. */
export function describeFailures(grade: Grade): string[] {
  const lines: string[] = [];
  if (grade.error) lines.push(grade.error);
  if (grade.formula) lines.push(`formula given: ${grade.formula}`);
  const seen = new Set<string>();
  for (const check of grade.checks) {
    if (check.ok) continue;
    const line = `${check.name}: expected ${show(check.expected)}, got ${show(check.got)}${check.note && !grade.error ? ` (${check.note})` : ''}`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}
