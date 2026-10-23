import { readFile } from 'node:fs/promises';

import type { Cell } from './formula.js';

export interface ExtractionTask {
  id: string;
  kind: 'extraction';
  title: string;
  /** Field name to a plain description, in the order the answer should list them. */
  fields: Record<string, string>;
  document: string;
  expected: Record<string, string | number | boolean | null>;
}

export interface FormulaTask {
  id: string;
  kind: 'formula';
  title: string;
  question: string;
  /** Row 0 is the header (sheet row 1). */
  table: Cell[][];
  /** A formula that produces `expected`; the tests check it does. */
  reference: string;
  /** When set, the formula is filled down this many rows from row 2. */
  fillDownRows?: number;
  expected: Cell | Cell[];
}

export type Task = ExtractionTask | FormulaTask;

export interface TaskSet {
  name: string;
  description: string;
  conventions: string[];
  tasks: Task[];
}

export async function loadTaskSet(path: string): Promise<TaskSet> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as TaskSet;
  const ids = new Set<string>();
  for (const task of parsed.tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    ids.add(task.id);
    if (task.kind !== 'extraction' && task.kind !== 'formula') {
      throw new Error(`task ${(task as { id: string }).id} has unknown kind`);
    }
  }
  return parsed;
}

export function pickTasks(set: TaskSet, ids: readonly string[]): Task[] {
  const byId = new Map(set.tasks.map((task) => [task.id, task]));
  return ids.map((id) => {
    const task = byId.get(id);
    if (!task) throw new Error(`unknown task id ${id} (known: ${[...byId.keys()].join(', ')})`);
    return task;
  });
}

function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function renderCell(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return String(cell).replace(/\|/g, '\\|');
}

export function renderSheet(table: Cell[][]): string {
  const width = Math.max(...table.map((row) => row.length));
  const header = ['', ...Array.from({ length: width }, (_, i) => columnLetter(i))];
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...table.map((row, r) => `| ${[String(r + 1), ...Array.from({ length: width }, (_, c) => renderCell(row[c] ?? null))].join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** The text the agent under test receives for one task. */
export function renderTaskPrompt(task: Task): string {
  if (task.kind === 'extraction') {
    const fields = Object.entries(task.fields).map(([name, description]) => `- ${name}: ${description}`);
    return [
      'Extract these fields from the document below and return them as one JSON object.',
      '',
      'Fields:',
      ...fields,
      '',
      'Document:',
      '"""',
      task.document,
      '"""',
    ].join('\n');
  }
  return [
    'The sheet below has its header in row 1. Row numbers are on the left and column letters on top.',
    '',
    renderSheet(task.table),
    '',
    task.question,
  ].join('\n');
}
