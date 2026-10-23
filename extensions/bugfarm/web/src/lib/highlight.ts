/**
 * A small unified-diff parser and a token highlighter for the languages
 * Bugfarm mines first (Python, TypeScript/JavaScript). Enough to make a diff
 * readable on screen; not a full grammar.
 */

export type TokenKind = 'kw' | 'str' | 'num' | 'fn' | 'com' | 'bi' | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
}

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'note';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  language: 'python' | 'ts' | 'plain';
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

function languageFor(path: string): DiffFile['language'] {
  if (/\.(py|pyi)$/.test(path)) return 'python';
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return 'ts';
  return 'plain';
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(raw);
      const path = match ? match[1] : raw.slice('diff --git '.length);
      file = { path, language: languageFor(path), additions: 0, deletions: 0, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) {
      if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
        const path = raw.slice(4).replace(/^[ab]\//, '');
        if (raw.startsWith('+++ ')) {
          file = { path, language: languageFor(path), additions: 0, deletions: 0, lines: [] };
          files.push(file);
        }
      }
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file')) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.lines.push({ type: 'hunk', text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (raw.startsWith('+')) {
      file.lines.push({ type: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
      file.additions += 1;
    } else if (raw.startsWith('-')) {
      file.lines.push({ type: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
      file.deletions += 1;
    } else if (raw.startsWith('\\')) {
      file.lines.push({ type: 'note', text: raw, oldNo: null, newNo: null });
    } else if (raw.length > 0 || file.lines.length > 0) {
      file.lines.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  for (const entry of files) {
    while (entry.lines.length > 0 && entry.lines[entry.lines.length - 1].type === 'ctx' && entry.lines[entry.lines.length - 1].text === '') entry.lines.pop();
  }
  return files;
}

const PY_KEYWORDS = new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));
const PY_BUILTINS = new Set('True False None self cls print len range min max int str float list dict set tuple isinstance super object Exception ValueError TypeError KeyError'.split(' '));
const TS_KEYWORDS = new Set('abstract as async await break case catch class const continue default delete do else enum export extends finally for from function if implements import in instanceof interface let new of private protected public readonly return static switch throw try type typeof var void while yield'.split(' '));
const TS_BUILTINS = new Set('true false null undefined this console Math JSON Object Array Promise Error Number String Boolean Map Set'.split(' '));

const PATTERNS: Record<'python' | 'ts', RegExp> = {
  python: /(#.*$)|([rbfu]{0,2}"""[\s\S]*?"""|[rbfu]{0,2}'''[\s\S]*?'''|[rbfu]{0,2}"(?:[^"\\]|\\.)*"?|[rbfu]{0,2}'(?:[^'\\]|\\.)*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|(@[A-Za-z_][\w.]*)|([A-Za-z_]\w*)|(\s+|[^\w\s]+)/gm,
  ts: /(\/\/.*$|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`?|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_]*(?:\.\d+)?\b)|(@[A-Za-z_][\w.]*)|([A-Za-z_$][\w$]*)|(\s+|[^\w\s$]+)/gm,
};

export function highlight(line: string, language: DiffFile['language']): Token[] {
  if (language === 'plain') return [{ kind: 'plain', text: line }];
  const keywords = language === 'python' ? PY_KEYWORDS : TS_KEYWORDS;
  const builtins = language === 'python' ? PY_BUILTINS : TS_BUILTINS;
  const pattern = new RegExp(PATTERNS[language].source, 'gm');
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let previousWord = '';
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) tokens.push({ kind: 'plain', text: line.slice(lastIndex, match.index) });
    const [text, comment, string, number, decorator, word] = match;
    if (comment) tokens.push({ kind: 'com', text });
    else if (string) tokens.push({ kind: 'str', text });
    else if (number) tokens.push({ kind: 'num', text });
    else if (decorator) tokens.push({ kind: 'fn', text });
    else if (word) {
      const rest = line.slice(match.index + text.length);
      if (keywords.has(word)) tokens.push({ kind: 'kw', text });
      else if (builtins.has(word)) tokens.push({ kind: 'bi', text });
      else if (previousWord === 'def' || previousWord === 'class' || previousWord === 'function' || /^\s*\(/.test(rest)) tokens.push({ kind: 'fn', text });
      else tokens.push({ kind: 'plain', text });
      previousWord = word;
    } else {
      tokens.push({ kind: 'plain', text });
    }
    lastIndex = match.index + text.length;
    if (text.length === 0) pattern.lastIndex += 1;
  }
  if (lastIndex < line.length) tokens.push({ kind: 'plain', text: line.slice(lastIndex) });
  return tokens;
}
