// A small reader for the TOML that Bugfarm's own pipeline writes into task.toml: tables, dotted
// table names, strings (basic, JSON-compatible escapes), numbers, booleans, and arrays of those,
// including arrays split over several lines. Not a general TOML parser; it never needs to be.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

function parseScalar(raw: string): TomlValue {
  const v = raw.trim();
  if (v.startsWith('"')) return JSON.parse(v) as string;
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[')) return parseArray(v);
  const n = Number(v.replace(/_/g, ''));
  if (Number.isFinite(n)) return n;
  return v;
}

/** Split an inline array body on top-level commas (strings may contain commas and brackets). */
function parseArray(text: string): TomlValue[] {
  const body = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out: TomlValue[] = [];
  let cur = '';
  let inStr: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      cur += c;
      if (c === '\\' && inStr === '"') {
        cur += body[++i] ?? '';
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
    } else if (c === '[') {
      depth++;
      cur += c;
    } else if (c === ']') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      if (cur.trim()) out.push(parseScalar(cur));
      cur = '';
    } else if (c === '#' && depth === 0) {
      // comment to end of line
      while (i < body.length && body[i] !== '\n') i++;
    } else cur += c;
  }
  if (cur.trim()) out.push(parseScalar(cur));
  return out;
}

/** Does `text` close every bracket it opens (outside strings)? */
function balanced(text: string): boolean {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\' && inStr === '"') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '#') break;
  }
  return depth <= 0;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      table = root;
      for (const part of header[1].split('.').map((p) => p.trim().replace(/^"|"$/g, ''))) {
        const next = table[part];
        if (next && typeof next === 'object' && !Array.isArray(next)) table = next;
        else {
          const created: TomlTable = {};
          table[part] = created;
          table = created;
        }
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('[')) {
      while (!balanced(value) && i + 1 < lines.length) value += '\n' + lines[++i];
    } else {
      // Strip a trailing comment outside a string.
      const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^#]*)/.exec(value);
      value = (m ? m[1] : value).trim();
    }
    table[key] = parseScalar(value);
  }
  return root;
}

export function tableAt(root: TomlTable, path: string): TomlTable | undefined {
  let cur: TomlValue | undefined = root;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as TomlTable)[part];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as TomlTable) : undefined;
}

export function str(t: TomlTable | undefined, key: string): string | undefined {
  const v = t?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(t: TomlTable | undefined, key: string): number | undefined {
  const v = t?.[key];
  return typeof v === 'number' ? v : undefined;
}

export function strArr(t: TomlTable | undefined, key: string): string[] {
  const v = t?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
