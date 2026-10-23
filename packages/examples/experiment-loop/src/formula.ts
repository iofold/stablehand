/**
 * A small spreadsheet engine for grading formula tasks. It parses one
 * Excel-style formula, evaluates it against an in-memory sheet with array
 * semantics, and refuses functions that Excel 2016 does not have, because the
 * benchmark's workbooks must open there.
 */

export type Cell = number | string | boolean | null;
export type Grid = Cell[][];
type Value = Cell | Grid;

export type SpreadsheetErrorCode = '#DIV/0!' | '#N/A' | '#VALUE!' | '#REF!' | '#NUM!';

/** An error value inside the sheet (#N/A, #DIV/0! ...). IFERROR catches it. */
export class SpreadsheetError extends Error {
  constructor(readonly code: SpreadsheetErrorCode, detail: string) {
    super(`${code} ${detail}`);
    this.name = 'SpreadsheetError';
  }
}

/** The formula cannot run on the target engine at all. IFERROR never hides it. */
export class FormulaRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaRejected';
  }
}

/** Functions added after Excel 2016. The benchmark's workbooks must open in Excel 2016. */
export const POST_2016_FUNCTIONS: ReadonlySet<string> = new Set([
  'BYCOL', 'BYROW', 'CHOOSECOLS', 'CHOOSEROWS', 'CONCAT', 'DROP', 'EXPAND', 'FILTER', 'HSTACK',
  'IFS', 'LAMBDA', 'LET', 'MAKEARRAY', 'MAP', 'MAXIFS', 'MINIFS', 'RANDARRAY', 'REDUCE', 'SCAN',
  'SEQUENCE', 'SORT', 'SORTBY', 'SWITCH', 'TAKE', 'TEXTAFTER', 'TEXTBEFORE', 'TEXTJOIN', 'TEXTSPLIT',
  'TOCOL', 'TOROW', 'UNIQUE', 'VSTACK', 'WRAPCOLS', 'WRAPROWS', 'XLOOKUP', 'XMATCH',
]);

interface CellRef {
  col: number;
  row: number | null;
  absCol: boolean;
  absRow: boolean;
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; ref: CellRef }
  | { t: 'range'; from: CellRef; to: CellRef }
  | { t: 'func'; name: string }
  | { t: 'op'; v: string }
  | { t: '(' }
  | { t: ')' }
  | { t: ',' };

type Node =
  | { k: 'lit'; v: Cell }
  | { k: 'ref'; ref: CellRef }
  | { k: 'range'; from: CellRef; to: CellRef }
  | { k: 'call'; name: string; args: Array<Node | null> }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'neg'; e: Node }
  | { k: 'pos'; e: Node }
  | { k: 'pct'; e: Node };

function columnIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

const CELL_RANGE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?/;
const COLUMN_RANGE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\w(])/;
const FUNCTION_NAME = /^([A-Za-z][A-Za-z0-9.]*)\s*\(/;
const NUMBER = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.]*/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = source[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= source.length) throw new FormulaRejected('unterminated text literal');
        if (source[j] === '"') {
          if (source[j + 1] === '"') { text += '"'; j += 2; continue; }
          break;
        }
        text += source[j];
        j += 1;
      }
      tokens.push({ t: 'str', v: text });
      i = j + 1;
      continue;
    }
    if (ch === '{') throw new FormulaRejected('array constants ({...}) are not supported by the grader');
    if (ch === ';') throw new FormulaRejected('separate function arguments with commas, not semicolons');
    if (ch === '(' || ch === ')' || ch === ',') { tokens.push({ t: ch }); i += 1; continue; }
    const two = source.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { tokens.push({ t: 'op', v: ch }); i += 1; continue; }
    const number = NUMBER.exec(rest);
    if (number) { tokens.push({ t: 'num', v: Number(number[0]) }); i += number[0].length; continue; }
    const func = FUNCTION_NAME.exec(rest);
    if (func) {
      tokens.push({ t: 'func', name: func[1]!.toUpperCase() });
      tokens.push({ t: '(' });
      i += func[0].length;
      continue;
    }
    const sheetRef = /^('[^']+'|[A-Za-z_][\w.]*)!/.exec(rest);
    if (sheetRef) throw new FormulaRejected(`references to other sheets (${sheetRef[0]}) are not available; the task has one sheet`);
    const cell = CELL_RANGE.exec(rest);
    if (cell) {
      const from: CellRef = { absCol: cell[1] === '$', col: columnIndex(cell[2]!), absRow: cell[3] === '$', row: Number(cell[4]) - 1 };
      if (cell[6] !== undefined) {
        const to: CellRef = { absCol: cell[5] === '$', col: columnIndex(cell[6]), absRow: cell[7] === '$', row: Number(cell[8]) - 1 };
        tokens.push({ t: 'range', from, to });
      } else {
        tokens.push({ t: 'ref', ref: from });
      }
      i += cell[0].length;
      continue;
    }
    const column = COLUMN_RANGE.exec(rest);
    if (column) {
      tokens.push({
        t: 'range',
        from: { absCol: column[1] === '$', col: columnIndex(column[2]!), absRow: true, row: null },
        to: { absCol: column[3] === '$', col: columnIndex(column[4]!), absRow: true, row: null },
      });
      i += column[0].length;
      continue;
    }
    const ident = IDENTIFIER.exec(rest);
    if (ident) {
      const word = ident[0].toUpperCase();
      if (word === 'TRUE' || word === 'FALSE') { tokens.push({ t: 'bool', v: word === 'TRUE' }); i += ident[0].length; continue; }
      throw new FormulaRejected(`unknown name ${ident[0]}: named ranges are not defined in this sheet`);
    }
    throw new FormulaRejected(`unexpected character "${ch}"`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.compare();
    if (this.pos < this.tokens.length) throw new FormulaRejected('unexpected text after the end of the formula');
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }

  private isOp(...ops: string[]): string | null {
    const token = this.peek();
    if (token?.t === 'op' && ops.includes(token.v)) { this.pos += 1; return token.v; }
    return null;
  }

  private compare(): Node {
    let left = this.concat();
    for (let op = this.isOp('=', '<>', '<', '>', '<=', '>='); op; op = this.isOp('=', '<>', '<', '>', '<=', '>=')) {
      left = { k: 'bin', op, l: left, r: this.concat() };
    }
    return left;
  }

  private concat(): Node {
    let left = this.additive();
    for (let op = this.isOp('&'); op; op = this.isOp('&')) left = { k: 'bin', op, l: left, r: this.additive() };
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (let op = this.isOp('+', '-'); op; op = this.isOp('+', '-')) left = { k: 'bin', op, l: left, r: this.multiplicative() };
    return left;
  }

  private multiplicative(): Node {
    let left = this.power();
    for (let op = this.isOp('*', '/'); op; op = this.isOp('*', '/')) left = { k: 'bin', op, l: left, r: this.power() };
    return left;
  }

  private power(): Node {
    let left = this.percent();
    for (let op = this.isOp('^'); op; op = this.isOp('^')) left = { k: 'bin', op, l: left, r: this.percent() };
    return left;
  }

  private percent(): Node {
    let node = this.unary();
    while (this.isOp('%')) node = { k: 'pct', e: node };
    return node;
  }

  private unary(): Node {
    if (this.isOp('-')) return { k: 'neg', e: this.unary() };
    if (this.isOp('+')) return { k: 'pos', e: this.unary() };
    return this.primary();
  }

  private primary(): Node {
    const token = this.peek();
    if (!token) throw new FormulaRejected('the formula ends too early');
    this.pos += 1;
    switch (token.t) {
      case 'num': return { k: 'lit', v: token.v };
      case 'str': return { k: 'lit', v: token.v };
      case 'bool': return { k: 'lit', v: token.v };
      case 'ref': return { k: 'ref', ref: token.ref };
      case 'range': return { k: 'range', from: token.from, to: token.to };
      case '(': {
        const inner = this.compare();
        if (this.peek()?.t !== ')') throw new FormulaRejected('missing closing parenthesis');
        this.pos += 1;
        return inner;
      }
      case 'func': return this.call(token.name);
      default: throw new FormulaRejected(`unexpected "${token.t === 'op' ? token.v : token.t}"`);
    }
  }

  private call(name: string): Node {
    // The tokenizer always emits "(" right after a function name.
    this.pos += 1;
    const args: Array<Node | null> = [];
    if (this.peek()?.t === ')') { this.pos += 1; return { k: 'call', name, args }; }
    for (;;) {
      const next = this.peek();
      args.push(next?.t === ',' || next?.t === ')' ? null : this.compare());
      const sep = this.peek();
      if (sep?.t === ',') { this.pos += 1; continue; }
      if (sep?.t === ')') { this.pos += 1; return { k: 'call', name, args }; }
      throw new FormulaRejected(`missing ")" after the arguments of ${name}`);
    }
  }
}

export function parseFormula(formula: string): Node {
  const source = formula.trim().replace(/^=/, '');
  if (!source) throw new FormulaRejected('empty formula');
  return new Parser(tokenize(source)).parse();
}

// ---------------------------------------------------------------- values

const isGrid = (value: Value): value is Grid => Array.isArray(value);

function shape(value: Value): [number, number] {
  return isGrid(value) ? [value.length, value[0]?.length ?? 0] : [1, 1];
}

function at(value: Value, row: number, col: number): Cell {
  if (!isGrid(value)) return value;
  const r = value.length === 1 ? 0 : row;
  const c = (value[0]?.length ?? 0) === 1 ? 0 : col;
  return value[r]?.[c] ?? null;
}

function broadcast(values: Value[], fn: (cells: Cell[]) => Cell): Value {
  if (!values.some(isGrid)) return fn(values as Cell[]);
  let rows = 1;
  let cols = 1;
  for (const value of values) {
    const [r, c] = shape(value);
    if (r !== 1) {
      if (rows !== 1 && rows !== r) throw new SpreadsheetError('#VALUE!', 'arrays of different sizes');
      rows = r;
    }
    if (c !== 1) {
      if (cols !== 1 && cols !== c) throw new SpreadsheetError('#VALUE!', 'arrays of different sizes');
      cols = c;
    }
  }
  const out: Grid = [];
  for (let r = 0; r < rows; r += 1) {
    const line: Cell[] = [];
    for (let c = 0; c < cols; c += 1) line.push(fn(values.map((value) => at(value, r, c))));
    out.push(line);
  }
  return out;
}

const flat = (value: Value): Cell[] => (isGrid(value) ? value.flat() : [value]);

const NUMERIC_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

function toNumber(cell: Cell): number {
  if (cell === null) return 0;
  if (typeof cell === 'number') return cell;
  if (typeof cell === 'boolean') return cell ? 1 : 0;
  if (NUMERIC_TEXT.test(cell)) return Number(cell);
  throw new SpreadsheetError('#VALUE!', `"${cell}" is not a number`);
}

function toText(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (typeof cell === 'number') return String(Number(cell.toPrecision(15)));
  return cell;
}

function toBool(cell: Cell): boolean {
  if (typeof cell === 'boolean') return cell;
  if (cell === null) return false;
  if (typeof cell === 'number') return cell !== 0;
  const upper = cell.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return upper === 'TRUE';
  throw new SpreadsheetError('#VALUE!', `"${cell}" is not TRUE or FALSE`);
}

function typeRank(cell: number | string | boolean): number {
  return typeof cell === 'number' ? 0 : typeof cell === 'string' ? 1 : 2;
}

/** Excel ordering: numbers < text < booleans; text compares without case. */
function compareCells(a: Cell, b: Cell): number {
  if (a === null && b === null) return 0;
  const blankLike = (other: Cell): Cell => (typeof other === 'number' ? 0 : typeof other === 'string' ? '' : false);
  const left = a === null ? blankLike(b) : a;
  const right = b === null ? blankLike(a) : b;
  if (left === null || right === null) return 0;
  const rank = typeRank(left) - typeRank(right);
  if (rank !== 0) return Math.sign(rank);
  if (typeof left === 'number' && typeof right === 'number') return Math.sign(left - right);
  if (typeof left === 'string' && typeof right === 'string') {
    const l = left.toLowerCase();
    const r = right.toLowerCase();
    return l < r ? -1 : l > r ? 1 : 0;
  }
  return Number(left) - Number(right);
}

function wildcardRegex(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '~' && i + 1 < pattern.length) { source += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; continue; }
    if (ch === '*') source += '[\\s\\S]*';
    else if (ch === '?') source += '[\\s\\S]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

function textMatches(cell: Cell, pattern: string): boolean {
  return typeof cell === 'string' && wildcardRegex(pattern).test(cell);
}

function numericEquals(cell: Cell, value: number): boolean {
  if (typeof cell === 'number') return cell === value;
  return typeof cell === 'string' && NUMERIC_TEXT.test(cell) && Number(cell) === value;
}

/** COUNTIF-style criterion: 5, "West", ">10", "<>Paid", "", "A*". */
export function criterionMatcher(criterion: Cell): (cell: Cell) => boolean {
  if (criterion === null) return (cell) => cell === null || cell === '';
  if (typeof criterion === 'number') return (cell) => numericEquals(cell, criterion);
  if (typeof criterion === 'boolean') return (cell) => cell === criterion;
  const match = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(criterion);
  const op = match?.[1] ?? '';
  const operand = match?.[2] ?? '';
  const numeric = NUMERIC_TEXT.test(operand) ? Number(operand) : null;
  const upper = operand.toUpperCase();
  const boolean = upper === 'TRUE' || upper === 'FALSE' ? upper === 'TRUE' : null;
  const equals = (cell: Cell): boolean => {
    if (operand === '') return cell === null || cell === '';
    if (numeric !== null) return numericEquals(cell, numeric);
    if (boolean !== null) return cell === boolean;
    return textMatches(cell, operand);
  };
  if (op === '' || op === '=') return equals;
  if (op === '<>') return (cell) => !equals(cell);
  const holds = (sign: number): boolean => (
    op === '<' ? sign < 0 : op === '>' ? sign > 0 : op === '<=' ? sign <= 0 : sign >= 0
  );
  if (numeric !== null) return (cell) => typeof cell === 'number' && holds(Math.sign(cell - numeric));
  return (cell) => typeof cell === 'string' && holds(compareCells(cell, operand));
}

function roundHalfAway(value: number, digits: number, mode: 'nearest' | 'up' | 'down'): number {
  const factor = 10 ** digits;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = mode === 'nearest' ? Math.round(scaled) : mode === 'up' ? Math.ceil(scaled) : Math.floor(scaled);
  return (Math.sign(value) * rounded) / factor;
}

// ------------------------------------------------------------ evaluation

interface EvalContext {
  rows: Grid;
  rowOffset: number;
}

function resolveRow(ref: CellRef, ctx: EvalContext): number {
  if (ref.row === null) return 0;
  const row = ref.row + (ref.absRow ? 0 : ctx.rowOffset);
  if (row < 0) throw new SpreadsheetError('#REF!', 'reference above row 1');
  return row;
}

function readRange(from: CellRef, to: CellRef, ctx: EvalContext): Grid {
  const wholeColumn = from.row === null || to.row === null;
  const r1 = wholeColumn ? 0 : resolveRow(from, ctx);
  const r2 = wholeColumn ? Math.max(ctx.rows.length - 1, 0) : resolveRow(to, ctx);
  const [top, bottom] = r1 <= r2 ? [r1, r2] : [r2, r1];
  const [left, right] = from.col <= to.col ? [from.col, to.col] : [to.col, from.col];
  const grid: Grid = [];
  for (let r = top; r <= bottom; r += 1) {
    const line: Cell[] = [];
    for (let c = left; c <= right; c += 1) line.push(ctx.rows[r]?.[c] ?? null);
    grid.push(line);
  }
  return grid;
}

type Evaluated = { value: Value; fromReference: boolean };

function evaluateNode(node: Node, ctx: EvalContext): Value {
  switch (node.k) {
    case 'lit': return node.v;
    case 'ref': return ctx.rows[resolveRow(node.ref, ctx)]?.[node.ref.col] ?? null;
    case 'range': return readRange(node.from, node.to, ctx);
    case 'neg': return broadcast([evaluateNode(node.e, ctx)], ([c]) => -toNumber(c ?? null));
    case 'pos': return evaluateNode(node.e, ctx);
    case 'pct': return broadcast([evaluateNode(node.e, ctx)], ([c]) => toNumber(c ?? null) / 100);
    case 'bin': return evaluateBinary(node.op, evaluateNode(node.l, ctx), evaluateNode(node.r, ctx));
    case 'call': return callFunction(node.name, node.args, ctx);
  }
}

function evaluateBinary(op: string, left: Value, right: Value): Value {
  return broadcast([left, right], ([a = null, b = null]) => {
    switch (op) {
      case '+': return toNumber(a) + toNumber(b);
      case '-': return toNumber(a) - toNumber(b);
      case '*': return toNumber(a) * toNumber(b);
      case '/': {
        const divisor = toNumber(b);
        if (divisor === 0) throw new SpreadsheetError('#DIV/0!', 'division by zero');
        return toNumber(a) / divisor;
      }
      case '^': return toNumber(a) ** toNumber(b);
      case '&': return toText(a) + toText(b);
      case '=': return compareCells(a, b) === 0;
      case '<>': return compareCells(a, b) !== 0;
      case '<': return compareCells(a, b) < 0;
      case '>': return compareCells(a, b) > 0;
      case '<=': return compareCells(a, b) <= 0;
      case '>=': return compareCells(a, b) >= 0;
      default: throw new FormulaRejected(`unknown operator ${op}`);
    }
  });
}

function requireArgs(name: string, args: Array<Node | null>, min: number, max: number): void {
  if (args.length < min || args.length > max) {
    throw new FormulaRejected(`${name} takes ${min === max ? min : `${min} to ${max === Infinity ? 'any number of' : max}`} arguments, got ${args.length}`);
  }
}

function evalArg(args: Array<Node | null>, index: number, ctx: EvalContext, fallback: Cell = null): Value {
  const node = args[index];
  return node ? evaluateNode(node, ctx) : fallback;
}

function evalWithOrigin(node: Node | null, ctx: EvalContext): Evaluated {
  if (!node) return { value: null, fromReference: false };
  return { value: evaluateNode(node, ctx), fromReference: node.k === 'ref' || node.k === 'range' };
}

/** SUM/AVERAGE/MIN/MAX inputs: arrays and references keep numbers only; typed values are coerced. */
function numbersOf(items: Evaluated[]): number[] {
  const out: number[] = [];
  for (const { value, fromReference } of items) {
    if (isGrid(value) || fromReference) {
      for (const cell of flat(value)) if (typeof cell === 'number') out.push(cell);
    } else if (value !== null) {
      out.push(toNumber(value));
    }
  }
  return out;
}

function asGrid(value: Value): Grid {
  return isGrid(value) ? value : [[value]];
}

function sameShape(a: Grid, b: Grid): boolean {
  return a.length === b.length && (a[0]?.length ?? 0) === (b[0]?.length ?? 0);
}

/** Matching cell positions for COUNTIFS/SUMIFS-style (range, criterion) pairs. */
function criteriaMask(pairs: Array<[Grid, Cell]>): boolean[] {
  const first = pairs[0]![0];
  for (const [range] of pairs) {
    if (!sameShape(range, first)) throw new SpreadsheetError('#VALUE!', 'criteria ranges must be the same size');
  }
  const cells = pairs.map(([range, criterion]) => ({ cells: range.flat(), match: criterionMatcher(criterion) }));
  return first.flat().map((_, index) => cells.every(({ cells: list, match }) => match(list[index] ?? null)));
}

function lookupEquals(cell: Cell, wanted: Cell): boolean {
  if (typeof wanted === 'string' && /[*?]/.test(wanted)) return textMatches(cell, wanted);
  return cell !== null && compareCells(cell, wanted) === 0 && typeof cell === typeof wanted;
}

function approximateIndex(cells: Cell[], wanted: Cell, descending = false): number {
  let found = -1;
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i] ?? null;
    if (cell === null || wanted === null || typeRank(cell) !== typeRank(wanted)) continue;
    const sign = compareCells(cell, wanted);
    if (descending ? sign >= 0 : sign <= 0) found = i;
    else break;
  }
  return found;
}

function callFunction(name: string, args: Array<Node | null>, ctx: EvalContext): Value {
  if (POST_2016_FUNCTIONS.has(name)) {
    throw new FormulaRejected(`${name} is not available in Excel 2016, and the workbook must open there`);
  }
  const lift = (count: number, fn: (cells: Cell[]) => Cell): Value => (
    broadcast(Array.from({ length: count }, (_, i) => evalArg(args, i, ctx)), fn)
  );

  switch (name) {
    case 'SUM': {
      requireArgs(name, args, 1, 255);
      return numbersOf(args.map((arg) => evalWithOrigin(arg, ctx))).reduce((a, b) => a + b, 0);
    }
    case 'AVERAGE': {
      requireArgs(name, args, 1, 255);
      const values = numbersOf(args.map((arg) => evalWithOrigin(arg, ctx)));
      if (values.length === 0) throw new SpreadsheetError('#DIV/0!', 'AVERAGE of no numbers');
      return values.reduce((a, b) => a + b, 0) / values.length;
    }
    case 'MIN':
    case 'MAX': {
      requireArgs(name, args, 1, 255);
      const values = numbersOf(args.map((arg) => evalWithOrigin(arg, ctx)));
      if (values.length === 0) return 0;
      return name === 'MIN' ? Math.min(...values) : Math.max(...values);
    }
    case 'LARGE':
    case 'SMALL': {
      requireArgs(name, args, 2, 2);
      const values = numbersOf([evalWithOrigin(args[0] ?? null, ctx)]).sort((a, b) => (name === 'LARGE' ? b - a : a - b));
      const k = toNumber(at(evalArg(args, 1, ctx), 0, 0));
      if (k < 1 || k > values.length) throw new SpreadsheetError('#NUM!', `${name} position out of range`);
      return values[Math.ceil(k) - 1] ?? null;
    }
    case 'COUNT': {
      requireArgs(name, args, 1, 255);
      let count = 0;
      for (const item of args.map((arg) => evalWithOrigin(arg, ctx))) {
        if (isGrid(item.value) || item.fromReference) count += flat(item.value).filter((cell) => typeof cell === 'number').length;
        else if (typeof item.value === 'number' || typeof item.value === 'boolean'
          || (typeof item.value === 'string' && NUMERIC_TEXT.test(item.value))) count += 1;
      }
      return count;
    }
    case 'COUNTA': {
      requireArgs(name, args, 1, 255);
      return args.reduce((count, arg) => count + (arg ? flat(evaluateNode(arg, ctx)).filter((cell) => cell !== null).length : 0), 0);
    }
    case 'COUNTBLANK': {
      requireArgs(name, args, 1, 1);
      return flat(evalArg(args, 0, ctx)).filter((cell) => cell === null || cell === '').length;
    }
    case 'COUNTIF': {
      requireArgs(name, args, 2, 2);
      const range = asGrid(evalArg(args, 0, ctx));
      return broadcast([evalArg(args, 1, ctx)], ([criterion = null]) => criteriaMask([[range, criterion]]).filter(Boolean).length);
    }
    case 'SUMIF':
    case 'AVERAGEIF': {
      requireArgs(name, args, 2, 3);
      const range = asGrid(evalArg(args, 0, ctx));
      const target = args[2] ? asGrid(evalArg(args, 2, ctx)) : range;
      if (!sameShape(range, target)) throw new SpreadsheetError('#VALUE!', `${name} ranges must be the same size`);
      return broadcast([evalArg(args, 1, ctx)], ([criterion = null]) => {
        const mask = criteriaMask([[range, criterion]]);
        const picked = target.flat().filter((cell, i) => mask[i] && typeof cell === 'number') as number[];
        if (name === 'SUMIF') return picked.reduce((a, b) => a + b, 0);
        if (picked.length === 0) throw new SpreadsheetError('#DIV/0!', 'no matching numbers');
        return picked.reduce((a, b) => a + b, 0) / picked.length;
      });
    }
    case 'COUNTIFS':
    case 'SUMIFS':
    case 'AVERAGEIFS': {
      const offset = name === 'COUNTIFS' ? 0 : 1;
      if (args.length < offset + 2 || (args.length - offset) % 2 !== 0) {
        throw new FormulaRejected(`${name} needs ${offset ? 'a range followed by ' : ''}range/criterion pairs`);
      }
      const target = offset ? asGrid(evalArg(args, 0, ctx)) : null;
      const ranges: Grid[] = [];
      const criteria: Value[] = [];
      for (let i = offset; i < args.length; i += 2) {
        ranges.push(asGrid(evalArg(args, i, ctx)));
        criteria.push(evalArg(args, i + 1, ctx));
      }
      if (target && !sameShape(target, ranges[0]!)) throw new SpreadsheetError('#VALUE!', `${name} ranges must be the same size`);
      return broadcast(criteria, (cells) => {
        const mask = criteriaMask(ranges.map((range, i) => [range, cells[i] ?? null]));
        if (!target) return mask.filter(Boolean).length;
        const picked = target.flat().filter((cell, i) => mask[i] && typeof cell === 'number') as number[];
        if (name === 'SUMIFS') return picked.reduce((a, b) => a + b, 0);
        if (picked.length === 0) throw new SpreadsheetError('#DIV/0!', 'no matching numbers');
        return picked.reduce((a, b) => a + b, 0) / picked.length;
      });
    }
    case 'SUMPRODUCT': {
      requireArgs(name, args, 1, 255);
      const arrays = args.map((_, i) => asGrid(evalArg(args, i, ctx)));
      const first = arrays[0]!;
      if (!arrays.every((array) => sameShape(array, first))) throw new SpreadsheetError('#VALUE!', 'SUMPRODUCT arrays must be the same size');
      const flats = arrays.map((array) => array.flat());
      let total = 0;
      for (let i = 0; i < flats[0]!.length; i += 1) {
        total += flats.reduce((product, list) => {
          const cell = list[i] ?? null;
          return product * (typeof cell === 'number' ? cell : 0);
        }, 1);
      }
      return total;
    }
    case 'ROUND':
    case 'ROUNDUP':
    case 'ROUNDDOWN': {
      requireArgs(name, args, 1, 2);
      const mode = name === 'ROUND' ? 'nearest' : name === 'ROUNDUP' ? 'up' : 'down';
      return lift(2, ([value = null, digits = null]) => roundHalfAway(toNumber(value), Math.trunc(toNumber(digits)), mode));
    }
    case 'INT': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => Math.floor(toNumber(value)));
    case 'ABS': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => Math.abs(toNumber(value)));
    case 'MOD': {
      requireArgs(name, args, 2, 2);
      return lift(2, ([a = null, b = null]) => {
        const divisor = toNumber(b);
        if (divisor === 0) throw new SpreadsheetError('#DIV/0!', 'MOD by zero');
        return toNumber(a) - divisor * Math.floor(toNumber(a) / divisor);
      });
    }
    case 'IF': {
      requireArgs(name, args, 2, 3);
      const condition = evalArg(args, 0, ctx);
      const branch = (index: number): (() => Value) => {
        let cached: { value?: Value; error?: unknown } | undefined;
        return () => {
          if (!cached) {
            try {
              cached = { value: args[index] ? evaluateNode(args[index]!, ctx) : index === 1 ? 0 : false };
            } catch (error) {
              if (!(error instanceof SpreadsheetError)) throw error;
              cached = { error };
            }
          }
          if (cached.error !== undefined) throw cached.error;
          return cached.value ?? null;
        };
      };
      const whenTrue = branch(1);
      const whenFalse = branch(2);
      if (!isGrid(condition)) return toBool(condition) ? whenTrue() : whenFalse();
      return condition.map((line, r) => line.map((cell, c) => (
        toBool(cell) ? at(whenTrue(), r, c) : at(whenFalse(), r, c)
      )));
    }
    case 'IFERROR':
    case 'IFNA': {
      requireArgs(name, args, 2, 2);
      try {
        return evalArg(args, 0, ctx);
      } catch (error) {
        if (error instanceof SpreadsheetError && (name === 'IFERROR' || error.code === '#N/A')) return evalArg(args, 1, ctx);
        throw error;
      }
    }
    case 'AND':
    case 'OR': {
      requireArgs(name, args, 1, 255);
      const values: boolean[] = [];
      for (const item of args.map((arg) => evalWithOrigin(arg, ctx))) {
        if (isGrid(item.value) || item.fromReference) {
          for (const cell of flat(item.value)) if (typeof cell === 'boolean' || typeof cell === 'number') values.push(toBool(cell));
        } else {
          values.push(toBool(item.value));
        }
      }
      if (values.length === 0) throw new SpreadsheetError('#VALUE!', `${name} has no logical values`);
      return name === 'AND' ? values.every(Boolean) : values.some(Boolean);
    }
    case 'NOT': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => !toBool(value));
    case 'LEN': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => toText(value).length);
    case 'UPPER': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => toText(value).toUpperCase());
    case 'LOWER': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => toText(value).toLowerCase());
    case 'TRIM': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => toText(value).trim().replace(/ +/g, ' '));
    case 'LEFT':
    case 'RIGHT': {
      requireArgs(name, args, 1, 2);
      return lift(2, ([value = null, count = null]) => {
        const text = toText(value);
        const n = args[1] ? Math.trunc(toNumber(count)) : 1;
        if (n < 0) throw new SpreadsheetError('#VALUE!', `${name} count is negative`);
        return name === 'LEFT' ? text.slice(0, n) : n === 0 ? '' : text.slice(-n);
      });
    }
    case 'MID': {
      requireArgs(name, args, 3, 3);
      return lift(3, ([value = null, start = null, count = null]) => {
        const s = Math.trunc(toNumber(start));
        const n = Math.trunc(toNumber(count));
        if (s < 1 || n < 0) throw new SpreadsheetError('#VALUE!', 'MID start or count out of range');
        return toText(value).slice(s - 1, s - 1 + n);
      });
    }
    case 'CONCATENATE': {
      requireArgs(name, args, 1, 255);
      return lift(args.length, (cells) => cells.map(toText).join(''));
    }
    case 'VALUE': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => toNumber(typeof value === 'string' ? value : toText(value)));
    case 'ISNUMBER': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => typeof value === 'number');
    case 'ISTEXT': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => typeof value === 'string');
    case 'ISBLANK': requireArgs(name, args, 1, 1); return lift(1, ([value = null]) => value === null);
    case 'INDEX': {
      requireArgs(name, args, 2, 3);
      const grid = asGrid(evalArg(args, 0, ctx));
      const rowNum = Math.trunc(toNumber(at(evalArg(args, 1, ctx), 0, 0)));
      const colArg = args[2] ? Math.trunc(toNumber(at(evalArg(args, 2, ctx), 0, 0))) : null;
      const rows = grid.length;
      const cols = grid[0]?.length ?? 0;
      let r = rowNum;
      let c = colArg ?? 1;
      if (colArg === null && rows === 1) { r = 1; c = rowNum; }
      if (colArg === null && rows > 1 && cols > 1) {
        if (rowNum < 1 || rowNum > rows) throw new SpreadsheetError('#REF!', 'INDEX row out of range');
        return [grid[rowNum - 1]!];
      }
      if (r === 0) return grid.map((line) => [line[c - 1] ?? null]);
      if (c === 0) return [grid[r - 1] ?? []];
      if (r < 1 || r > rows || c < 1 || c > cols) throw new SpreadsheetError('#REF!', 'INDEX position out of range');
      return grid[r - 1]![c - 1] ?? null;
    }
    case 'MATCH': {
      requireArgs(name, args, 2, 3);
      const array = asGrid(evalArg(args, 1, ctx));
      if (array.length > 1 && (array[0]?.length ?? 0) > 1) throw new SpreadsheetError('#N/A', 'MATCH needs one row or one column');
      const type = args[2] ? Math.sign(toNumber(at(evalArg(args, 2, ctx), 0, 0))) : 1;
      const cells = array.flat();
      return broadcast([evalArg(args, 0, ctx)], ([wanted = null]) => {
        const index = type === 0
          ? cells.findIndex((cell) => lookupEquals(cell, wanted))
          : approximateIndex(cells, wanted, type < 0);
        if (index < 0) throw new SpreadsheetError('#N/A', `MATCH found no ${toText(wanted)}`);
        return index + 1;
      });
    }
    case 'VLOOKUP':
    case 'HLOOKUP': {
      requireArgs(name, args, 3, 4);
      const table = asGrid(evalArg(args, 1, ctx));
      const lines = name === 'VLOOKUP' ? table : table[0]!.map((_, c) => table.map((line) => line[c] ?? null));
      const index = Math.trunc(toNumber(at(evalArg(args, 2, ctx), 0, 0)));
      const approximate = args[3] ? toBool(at(evalArg(args, 3, ctx), 0, 0)) : true;
      if (index < 1) throw new SpreadsheetError('#VALUE!', `${name} column index below 1`);
      if (index > (lines[0]?.length ?? 0)) throw new SpreadsheetError('#REF!', `${name} column index beyond the table`);
      const keys = lines.map((line) => line[0] ?? null);
      return broadcast([evalArg(args, 0, ctx)], ([wanted = null]) => {
        const row = approximate ? approximateIndex(keys, wanted) : keys.findIndex((cell) => lookupEquals(cell, wanted));
        if (row < 0) throw new SpreadsheetError('#N/A', `${name} found no ${toText(wanted)}`);
        return lines[row]![index - 1] ?? null;
      });
    }
    default:
      throw new FormulaRejected(`${name} is not supported by this grader`);
  }
}

export interface EvaluateOptions {
  /** Rows to shift relative references by, as when the formula is filled down. */
  rowOffset?: number;
}

/**
 * Evaluate one formula against `rows` (row 0 is sheet row 1). Returns the
 * cell value; throws SpreadsheetError for an error value and FormulaRejected
 * when the formula cannot run on the target engine.
 */
export function evaluateFormula(formula: string, rows: Grid, options: EvaluateOptions = {}): Cell {
  const ast = parseFormula(formula);
  const value = evaluateNode(ast, { rows, rowOffset: options.rowOffset ?? 0 });
  if (!isGrid(value)) return value;
  if (value.length === 1 && value[0]?.length === 1) return value[0][0] ?? null;
  throw new FormulaRejected('the formula returns a list of values; the task asks for one value');
}
