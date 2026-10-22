#!/usr/bin/env node
/* global process, console */
// Mechanical checks from RULES.md (condensed from skill-deslop by Stephen D.
// Turner, MIT). Usage: node check.mjs <draft-file> [more files...]
// Prints one JSON report per file and exits 1 when any file has issues.
// It catches what a regex can; the writer still rereads against RULES.md.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PHRASES = [
  "here's the thing", "here's why", "here's what", 'the truth is', 'let me be clear', 'it turns out',
  'let that sink in', 'full stop', 'make no mistake', 'this matters because',
  "let's dive in", "let's break this down", "let's unpack", 'think of it as', 'think of it like', 'imagine a world',
  'leverage', 'utilize', 'robust', 'streamline', 'landscape', 'ecosystem', 'delve', 'tapestry', 'synergy',
  'paradigm', 'game-changer', 'game changer', 'deep dive', 'moving forward', 'circle back', 'double down',
  "it's worth noting", 'it is worth noting', 'at its core', 'at the end of the day', 'when it comes to',
  "in today's", 'in conclusion', 'to sum up', 'serves as', 'stands as', 'unlock', 'supercharge', 'seamless',
];

const ADVERBS = [
  'really', 'just', 'literally', 'genuinely', 'honestly', 'simply', 'actually', 'deeply', 'truly',
  'fundamentally', 'inherently', 'inevitably', 'interestingly', 'importantly', 'crucially', 'quietly',
  'remarkably', 'arguably', 'notably',
];

const PATTERNS = [
  { rule: 'em-dash', re: /[—–]|\s--\s/g, hint: 'Use a comma, a period or parentheses.' },
  { rule: 'binary-contrast', re: /\b(?:it's|it is|this is|that's)\s+not\b[^.!?\n]{0,80}[.,;]\s*(?:it's|it is|this is|that's)\b/gi, hint: 'State the point directly.' },
  { rule: 'not-just', re: /\bnot (?:just|only|merely)\b/gi, hint: 'State the point directly.' },
  { rule: 'self-answered-question', re: /\?\s+[A-Z][^.?!\n]{0,30}\.(?=\s|$)/g, hint: 'Fold the question into a statement.' },
  { rule: 'bold-first-bullet', re: /^\s*(?:[-*]|\d+\.)\s+\*\*/gm, hint: 'Drop the bold lead.' },
  { rule: 'unicode-arrow', re: /[←-⇿⟵-⟿]/g, hint: 'Write the words.' },
];

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function excerpt(text, index, length) {
  return text.slice(Math.max(0, index - 20), index + length + 20).replace(/\s+/g, ' ').trim();
}

export function checkDraft(text) {
  const issues = [];
  const lower = text.toLowerCase();
  for (const phrase of PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    for (const match of lower.matchAll(re)) {
      issues.push({ rule: 'phrase', match: phrase, line: lineOf(text, match.index), excerpt: excerpt(text, match.index, phrase.length) });
    }
  }
  for (const adverb of ADVERBS) {
    for (const match of lower.matchAll(new RegExp(`\\b${adverb}\\b`, 'g'))) {
      issues.push({ rule: 'adverb', match: adverb, line: lineOf(text, match.index), excerpt: excerpt(text, match.index, adverb.length) });
    }
  }
  for (const { rule, re, hint } of PATTERNS) {
    for (const match of text.matchAll(re)) {
      issues.push({ rule, match: match[0].trim(), hint, line: lineOf(text, match.index), excerpt: excerpt(text, match.index, match[0].length) });
    }
  }
  const hashtags = text.match(/(^|\s)#[A-Za-z]\w+/g) ?? [];
  if (hashtags.length > 2) {
    issues.push({ rule: 'hashtags', match: hashtags.join(' ').trim(), hint: 'At most two hashtags.' });
  }
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return { ok: issues.length === 0, issues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node check.mjs <draft-file> [more files...]');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const report = checkDraft(readFileSync(file, 'utf8'));
    failed ||= !report.ok;
    console.log(JSON.stringify({ file, ...report }));
  }
  process.exit(failed ? 1 : 0);
}
