#!/usr/bin/env node
/* global process, console */
// Checks that every extracted field quotes the email it came from.
// Usage: node spans.mjs <email.txt> <fields.json>
// fields.json is a list of {"field", "value", "quote"}. Each quote must be an
// exact span of the email (runs of spaces and line breaks count as one space,
// curly quotes match straight ones). Prints one JSON report with the line each
// quote starts on and a "table" ready for a2ui-render's TableView, and exits 1
// when any quote is missing from the email.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_QUOTE_LENGTH = 300;

function canonicalChar(char) {
  if (char === '‘' || char === '’') return "'";
  if (char === '“' || char === '”') return '"';
  return char;
}

/** Collapse whitespace and quote styles, keeping a map back to the original offsets. */
function normalize(text) {
  let out = '';
  const offsets = [];
  let pendingSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      offsets.push(index);
      pendingSpace = false;
    }
    out += canonicalChar(char);
    offsets.push(index);
  }
  return { text: out, offsets };
}

function lineAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') line += 1;
  }
  return line;
}

export function checkSpans(emailText, fields) {
  const email = emailText.replace(/\r\n/g, '\n');
  const normalizedEmail = normalize(email);
  const rows = [];
  const issues = [];
  if (!Array.isArray(fields)) {
    return { ok: false, rows, issues: [{ field: null, problem: 'fields.json must be a JSON list of {field, value, quote}' }] };
  }
  for (const entry of fields) {
    const field = typeof entry?.field === 'string' ? entry.field.trim() : '';
    const value = entry?.value === undefined || entry?.value === null ? '' : String(entry.value).trim();
    const quote = typeof entry?.quote === 'string' ? entry.quote : '';
    if (!field) {
      issues.push({ field: null, problem: 'an entry has no field name' });
      continue;
    }
    if (!value) {
      issues.push({ field, problem: 'value is empty' });
      continue;
    }
    if (!quote.trim()) {
      issues.push({ field, problem: 'quote is empty; copy the words from the email that show this value' });
      continue;
    }
    if (quote.length > MAX_QUOTE_LENGTH) {
      issues.push({ field, problem: `quote is longer than ${MAX_QUOTE_LENGTH} characters; quote the shortest span that shows the value` });
      continue;
    }
    const needle = normalize(quote).text;
    const found = normalizedEmail.text.indexOf(needle);
    if (found === -1) {
      issues.push({ field, problem: 'quote is not in the email; copy it character for character or drop the field', quote });
      continue;
    }
    rows.push({ field, value, quote: needle, line: lineAt(email, normalizedEmail.offsets[found]) });
  }
  rows.sort((a, b) => a.line - b.line);
  return {
    ok: issues.length === 0 && rows.length > 0,
    rows,
    issues,
    table: {
      title: 'What the email says, and where',
      columns: [
        { key: 'field', label: 'Field' },
        { key: 'value', label: 'Value' },
        { key: 'quote', label: 'Quoted from the email' },
        { key: 'line', label: 'Line' },
      ],
      data: rows.map((row) => ({ ...row, quote: `"${row.quote}"` })),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [emailPath, fieldsPath] = process.argv.slice(2);
  if (!emailPath || !fieldsPath) {
    console.error('usage: node spans.mjs <email.txt> <fields.json>');
    process.exit(2);
  }
  let fields;
  try {
    fields = JSON.parse(readFileSync(fieldsPath, 'utf8'));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, rows: [], issues: [{ field: null, problem: `fields.json is not valid JSON: ${error.message}` }] }));
    process.exit(1);
  }
  const report = checkSpans(readFileSync(emailPath, 'utf8'), fields);
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
