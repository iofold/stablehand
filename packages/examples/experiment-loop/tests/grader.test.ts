import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { evaluateFormula, FormulaRejected, SpreadsheetError, type Cell } from '../src/formula.js';
import { describeFailures, extractFormula, extractJsonObject, gradeAnswer } from '../src/grader.js';
import { loadTaskSet, renderTaskPrompt, type FormulaTask, type Task, type TaskSet } from '../src/tasks.js';

const TASKS_PATH = fileURLToPath(new URL('../tasks/tasks.json', import.meta.url));
let taskSet: TaskSet;

beforeAll(async () => {
  taskSet = await loadTaskSet(TASKS_PATH);
});

function task(id: string): Task {
  const found = taskSet.tasks.find((entry) => entry.id === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
}

function formulaTask(id: string): FormulaTask {
  const found = task(id);
  if (found.kind !== 'formula') throw new Error(`${id} is not a formula task`);
  return found;
}

const SHEET: Cell[][] = [
  ['Order', 'Region', 'Units', 'Price', 'Status'],
  ['SO-1', 'West', 12, 19.5, 'Shipped'],
  ['SO-2', 'North', 4, 120, 'Shipped'],
  ['SO-3', 'West', 30, 7.25, 'Cancelled'],
];

describe('task set', () => {
  it('holds 16 tasks, half extraction and half formula, with unique ids', () => {
    expect(taskSet.tasks).toHaveLength(16);
    expect(taskSet.tasks.filter((entry) => entry.kind === 'extraction')).toHaveLength(8);
    expect(new Set(taskSet.tasks.map((entry) => entry.id)).size).toBe(16);
  });

  it('every reference formula produces the expected value, filled down where asked', () => {
    for (const entry of taskSet.tasks) {
      if (entry.kind !== 'formula') continue;
      const expected = entry.fillDownRows ? entry.expected as Cell[] : [entry.expected as Cell];
      expected.forEach((value, offset) => {
        const got = evaluateFormula(entry.reference, entry.table, { rowOffset: offset });
        if (typeof value === 'number') expect(got, `${entry.id} row ${offset}`).toBeCloseTo(value, 9);
        else expect(got, `${entry.id} row ${offset}`).toBe(value);
      });
    }
  });

  it('a perfect answer to every task scores 1', () => {
    for (const entry of taskSet.tasks) {
      const answer = entry.kind === 'extraction'
        ? `\`\`\`json\n${JSON.stringify(entry.expected)}\n\`\`\``
        : entry.reference;
      expect(gradeAnswer(entry, answer).score, entry.id).toBe(1);
    }
  });

  it('renders extraction fields and a lettered sheet into the prompt', () => {
    const extraction = renderTaskPrompt(task('ext-invoice-berlin'));
    expect(extraction).toContain('- vendor_phone: the vendor\'s phone number');
    expect(extraction).toContain('Kreuzberg Kaffeemaschinen GmbH');
    const sheet = renderTaskPrompt(task('fx-price-lookup'));
    expect(sheet).toContain('|  | A | B | C | D |');
    expect(sheet).toContain('| 4 | P-1043 | Conduit 25mm 3m | 9.8 | 340 |');
    expect(sheet).toContain('unit price of SKU P-1043');
  });
});

describe('formula engine', () => {
  it('follows Excel precedence and coercion', () => {
    expect(evaluateFormula('=2+3*4', SHEET)).toBe(14);
    expect(evaluateFormula('=-2^2', SHEET)).toBe(4);
    expect(evaluateFormula('="SO-"&C2', SHEET)).toBe('SO-12');
    expect(evaluateFormula('=50%*C2', SHEET)).toBe(6);
    expect(evaluateFormula('=B2="west"', SHEET)).toBe(true);
  });

  it('evaluates criteria functions and array formulas', () => {
    expect(evaluateFormula('=COUNTIFS(B2:B4,"West",E2:E4,"<>Cancelled")', SHEET)).toBe(1);
    expect(evaluateFormula('=SUMIF(C2:C4,">10")', SHEET)).toBe(42);
    expect(evaluateFormula('=COUNTIF(A2:A4,"SO-*")', SHEET)).toBe(3);
    expect(evaluateFormula('=SUMPRODUCT(--(B2:B4="West"),C2:C4)', SHEET)).toBe(42);
    expect(evaluateFormula('=SUMPRODUCT(C:C,D:D)', SHEET)).toBe(12 * 19.5 + 4 * 120 + 30 * 7.25);
  });

  it('treats booleans in SUMPRODUCT as zero, as Excel does', () => {
    expect(evaluateFormula('=SUMPRODUCT((B2:B4="West"),C2:C4)', SHEET)).toBe(0);
  });

  it('refuses functions Excel 2016 does not have, even inside IFERROR', () => {
    expect(() => evaluateFormula('=XLOOKUP("SO-2",A2:A4,D2:D4)', SHEET)).toThrow(FormulaRejected);
    expect(() => evaluateFormula('=IFERROR(MAXIFS(C2:C4,B2:B4,"West"),0)', SHEET)).toThrow(/Excel 2016/);
    expect(() => evaluateFormula('=COUNTA(UNIQUE(B2:B4))', SHEET)).toThrow(/UNIQUE is not available/);
  });

  it('raises sheet errors that IFERROR can catch', () => {
    expect(() => evaluateFormula('=1/0', SHEET)).toThrow(SpreadsheetError);
    expect(() => evaluateFormula('=VLOOKUP("SO-9",A2:D4,4,FALSE)', SHEET)).toThrow('#N/A');
    expect(evaluateFormula('=IFERROR(VLOOKUP("SO-9",A2:D4,4,FALSE),"none")', SHEET)).toBe('none');
    expect(evaluateFormula('=VLOOKUP("so-2",A2:D4,4,FALSE)', SHEET)).toBe(120);
  });

  it('shifts relative references when filled down and keeps absolute ones', () => {
    expect(evaluateFormula('=C2*2', SHEET, { rowOffset: 2 })).toBe(60);
    expect(evaluateFormula('=$C$2*2', SHEET, { rowOffset: 2 })).toBe(24);
  });

  it('explains formulas it cannot parse', () => {
    expect(() => evaluateFormula('=SUM(C2:C4;D2:D4)', SHEET)).toThrow(/commas, not semicolons/);
    expect(() => evaluateFormula('=Sheet2!A1', SHEET)).toThrow(/other sheets/);
    expect(() => evaluateFormula('=SUM(C2:C4', SHEET)).toThrow(FormulaRejected);
  });
});

describe('grader', () => {
  it('finds JSON in fences or prose and formulas on their own line or in code', () => {
    expect(extractJsonObject('Here you go:\n{"a": {"b": 1}, "c": "x}"} thanks')).toEqual({ a: { b: 1 }, c: 'x}' });
    expect(extractJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('no object here')).toBeNull();
    expect(extractFormula('Use this:\n\n```excel\n=SUM(A1:A3)\n```')).toBe('=SUM(A1:A3)');
    expect(extractFormula('The formula is `=INDEX(C2:C9,3)`.')).toBe('=INDEX(C2:C9,3)');
    expect(extractFormula('=MAX(B2:B9)')).toBe('=MAX(B2:B9)');
    expect(extractFormula('I cannot do that')).toBeNull();
  });

  it('grades extraction field by field and says what went wrong', () => {
    const invoice = task('ext-invoice-berlin');
    if (invoice.kind !== 'extraction') throw new Error('expected extraction');
    const answer = JSON.stringify({
      ...invoice.expected,
      total: 2484.13,
      vendor_country: 'Germany',
      vat_rate: '0.19',
    });
    const grade = gradeAnswer(invoice, answer);
    expect(grade.score).toBeCloseTo(6 / 9, 9);
    expect(describeFailures(grade)).toEqual([
      'total: expected 248413, got 2484.13',
      'vat_rate: expected 0.19, got "0.19" (given as text, expected a number)',
      'vendor_country: expected "DE", got "Germany"',
    ]);
    expect(gradeAnswer(invoice, 'Sorry, no JSON.').error).toBe('no JSON object in the answer');
  });

  it('grades formulas by running them', () => {
    const lookup = task('fx-price-lookup');
    expect(gradeAnswer(lookup, '=VLOOKUP("P-1043",A2:D9,3,FALSE)').score).toBe(1);
    const rejected = gradeAnswer(lookup, '```\n=XLOOKUP("P-1043",A2:A9,C2:C9)\n```');
    expect(rejected.score).toBe(0);
    expect(describeFailures(rejected)[0]).toContain('XLOOKUP is not available in Excel 2016');
  });

  it('gives partial credit when a filled-down formula anchors the wrong cell', () => {
    const commission = formulaTask('fx-commission');
    const grade = gradeAnswer(commission, '=ROUND(MIN($C$2,10000)*0.02+MAX($C$2-10000,0)*0.05,2)');
    expect(grade.score).toBeCloseTo(1 / 6, 9);
    expect(grade.checks.map((check) => check.name)).toEqual(['D2', 'D3', 'D4', 'D5', 'D6', 'D7']);
  });
});
