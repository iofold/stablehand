#!/usr/bin/env node
/* global process, console */
// Checks that every finding quotes the page or section it cites.
// Usage:
//   node check_findings.mjs <review-dir>            check findings.json
//   node check_findings.mjs <review-dir> --report   also write report.md and print a TableView "table"
// <review-dir> holds corpus.json from read_folder.py. A finding is
// {"severity", "document", "location", "quote", "finding", "policy"}.
// Locations are "page 3" for PDFs and "§ <heading>" for sections. Quotes
// match ignoring case, runs of whitespace and curly quotes. A finding that
// quotes a clause another document replaced must mention that document.
// The report's summary lists the findings to act on first, copied from the
// checked findings. Prints one JSON report and exits 1 when there are issues.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERITIES = ['high', 'medium', 'low'];
const MAX_QUOTE_LENGTH = 400;

function canonical(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "p. 4, clause 10.1" -> "page 4"; "Section 4. Prices" -> "4. prices". */
function locationKey(location) {
  const text = canonical(location);
  const page = /\b(?:page|p\.?)\s*(\d+)\b/.exec(text);
  if (page) return `page ${page[1]}`;
  return text.replace(/^§\s*/, '').replace(/^(section|sec\.)\s+/, '').trim();
}

function findDocument(corpus, name) {
  const wanted = canonical(name);
  return corpus.documents.find((document) => canonical(document.document) === wanted)
    ?? corpus.documents.find((document) => canonical(document.document).split('/').pop() === wanted.split('/').pop());
}

function findLocation(document, location) {
  const key = locationKey(location);
  const exact = document.locations.find((entry) => locationKey(entry.location) === key);
  if (exact) return exact;
  // "§ 4" names the section whose heading starts with "4."; "§ 2.2" falls
  // back to its parent section "2." when the clause has no heading of its own.
  let number = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(key)?.[1];
  while (number) {
    const pattern = new RegExp(`^${number.replace(/\./g, '\\.')}\\.?\\s`);
    const match = document.locations.find((entry) => pattern.test(locationKey(entry.location)));
    if (match) return match;
    number = number.includes('.') ? number.slice(0, number.lastIndexOf('.')) : undefined;
  }
  return undefined;
}

/** The numbered clause ("10.1") whose text holds the quote, if any. */
function clauseOf(text, quote) {
  const blocks = [];
  let current = { clause: null, lines: [] };
  for (const line of String(text).split('\n')) {
    const numbered = /^\s*(\d+(?:\.\d+)+)\s/.exec(line);
    if (numbered) {
      blocks.push(current);
      current = { clause: numbered[1], lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  const needle = canonical(quote);
  return blocks.find((block) => canonical(block.lines.join(' ')).includes(needle))?.clause ?? null;
}

/** Check one cited quote; returns { cite, location } or { problem }. */
function checkCitation(corpus, entry) {
  const quote = typeof entry?.quote === 'string' ? entry.quote : '';
  if (!entry?.document) return { problem: 'document is missing' };
  if (!entry?.location) return { problem: 'location is missing; use "page N" or "§ <heading>" from the corpus headers' };
  if (!quote.trim()) return { problem: 'quote is empty; copy the words that show it' };
  if (quote.length > MAX_QUOTE_LENGTH) return { problem: `quote is longer than ${MAX_QUOTE_LENGTH} characters; quote the shortest span that shows it` };
  const document = findDocument(corpus, entry.document);
  if (!document) return { problem: `no document named ${entry.document} in the folder` };
  const location = findLocation(document, entry.location);
  if (!location) {
    return { problem: `${document.document} has no ${entry.location}; its locations are ${document.locations.map((item) => item.location).join(', ')}` };
  }
  const needle = canonical(quote);
  if (!canonical(location.text).includes(needle)) {
    const elsewhere = document.locations.find((item) => canonical(item.text).includes(needle));
    return {
      problem: elsewhere
        ? `the quote is on ${elsewhere.location} of ${document.document}, not ${location.location}`
        : `the quote is not in ${document.document}; copy it word for word or drop it`,
    };
  }
  return {
    cite: { document: document.document, location: location.location, quote: quote.replace(/\s+/g, ' ').trim() },
    location,
  };
}

/** A change from another document that replaced the clause this finding quotes. */
function replacedBy(corpus, cite, location, findingText) {
  const clause = clauseOf(location.text, cite.quote);
  if (!clause) return undefined;
  const change = (corpus.changes ?? []).find((entry) => entry.clause === clause && entry.document !== cite.document);
  if (!change) return undefined;
  const text = canonical(findingText);
  const mentioned = text.includes(canonical(change.document)) || text.includes(canonical(basename(change.document).replace(/\.[^.]+$/, '')))
    || /\bamend/.test(text);
  return mentioned ? undefined : change;
}

export function checkFindings(corpus, findings) {
  const rows = [];
  const issues = [];
  if (!Array.isArray(findings)) {
    return { ok: false, rows, issues: [{ index: null, problem: 'findings.json must be a JSON list' }] };
  }
  findings.forEach((finding, index) => {
    const severity = typeof finding?.severity === 'string' ? finding.severity.toLowerCase() : '';
    const text = typeof finding?.finding === 'string' ? finding.finding.trim() : '';
    if (!SEVERITIES.includes(severity)) {
      issues.push({ index, problem: 'severity must be high, medium or low' });
      return;
    }
    if (!text) {
      issues.push({ index, problem: 'finding is empty' });
      return;
    }
    const checked = checkCitation(corpus, finding);
    if (checked.problem) {
      issues.push({ index, finding: text, problem: checked.problem });
      return;
    }
    const change = replacedBy(corpus, checked.cite, checked.location, text);
    if (change) {
      issues.push({
        index,
        finding: text,
        problem: `clause ${change.clause} that this quotes was replaced by ${change.document} (${change.location}): "${change.text.slice(0, 160)}". `
          + 'Drop this finding, or report what the new wording means and cite that document.',
      });
      return;
    }
    rows.push({
      severity,
      finding: text,
      policy: typeof finding.policy === 'string' ? finding.policy.trim() : '',
      ...checked.cite,
    });
  });
  rows.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, rows.filter((row) => row.severity === severity).length]));
  const cited = new Set(rows.map((row) => row.document));
  return {
    ok: issues.length === 0 && rows.length > 0,
    rows,
    issues,
    counts,
    documentsWithoutFindings: corpus.documents.map((document) => document.document).filter((name) => !cited.has(name)),
  };
}

export function findingsTable(rows) {
  return {
    title: `Findings (${rows.length})`,
    columns: [
      { key: 'severity', label: 'Severity' },
      { key: 'finding', label: 'Finding' },
      { key: 'where', label: 'Where' },
      { key: 'quote', label: 'Quote' },
    ],
    data: rows.map((row) => ({
      severity: row.severity,
      finding: row.finding,
      where: `${row.document}, ${row.location}`,
      quote: `"${row.quote}"`,
    })),
    pageSize: 15,
  };
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** The findings to act on first: every high one (up to 5), else the first 3. */
export function summarize(rows) {
  const high = rows.filter((row) => row.severity === 'high');
  const first = (high.length > 0 ? high : rows).slice(0, high.length > 0 ? 5 : 3);
  if (first.length === 0) return 'No findings.';
  const lead = high.length > 0 ? 'Act on these first:' : 'Nothing is high. Look at these first:';
  return [lead, ...first.map((row, index) => `${index + 1}. ${row.finding} (${row.document}, ${row.location})`)].join('\n');
}

export function renderReport(corpus, report, date = new Date().toISOString().slice(0, 10)) {
  const lines = [
    '# Folder review',
    '',
    `Reviewed ${date}. Read ${corpus.documents.length} documents; every finding cites the page or section it came from.`,
    '',
    '## Summary',
    '',
    `${report.counts.high} high, ${report.counts.medium} medium and ${report.counts.low} low findings.`,
    '',
    summarize(report.rows),
    '',
    '## Findings',
    '',
    '| # | Severity | Finding | Where |',
    '|---|---|---|---|',
    ...report.rows.map((row, index) => `| ${index + 1} | ${row.severity} | ${cell(row.finding)} | ${cell(`${row.document}, ${row.location}`)} |`),
    '',
    '## Evidence',
    '',
  ];
  report.rows.forEach((row, index) => {
    lines.push(`### ${index + 1}. ${row.finding}`, '', `${row.document}, ${row.location}:`, '', `> ${row.quote}`, '');
    if (row.policy) lines.push(`Policy: ${row.policy}`, '');
  });
  lines.push('## Documents read', '', '| Document | Type | Pages or sections | Findings |', '|---|---|---|---|');
  for (const document of corpus.documents) {
    const count = report.rows.filter((row) => row.document === document.document).length;
    lines.push(`| ${cell(document.document)} | ${document.type} | ${document.locations.length} | ${count} |`);
  }
  for (const entry of corpus.skipped ?? []) {
    lines.push(`| ${cell(entry.document)} | skipped | ${cell(entry.reason)} | 0 |`);
  }
  return `${lines.join('\n')}\n`;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, issues: [{ index: null, problem: `${label} could not be read: ${error.message}` }] }));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, mode] = process.argv.slice(2);
  if (!dir || (mode && mode !== '--report')) {
    console.error('usage: node check_findings.mjs <review-dir> [--report]');
    process.exit(2);
  }
  const corpus = readJson(join(dir, 'corpus.json'), 'corpus.json (run read_folder.py first)');
  const report = checkFindings(corpus, readJson(join(dir, 'findings.json'), 'findings.json'));
  if (mode === '--report' && report.ok) {
    const path = join(dir, 'report.md');
    writeFileSync(path, renderReport(corpus, report));
    console.log(JSON.stringify({
      ok: true,
      counts: report.counts,
      summary: summarize(report.rows),
      report: path,
      table: findingsTable(report.rows),
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({ ok: report.ok, counts: report.counts, issues: report.issues, documentsWithoutFindings: report.documentsWithoutFindings }));
  process.exit(report.ok ? 0 : 1);
}
