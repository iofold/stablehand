import { describeUnit, ensureClone, numstat } from '../../pipeline/lib/git.ts';
import { classify, profileFor } from '../../pipeline/lib/repos.ts';
import { candidateFromUnit } from '../../pipeline/lib/scout.ts';
import type { CandidateFeatures } from '../shared/predicate.js';

/**
 * A candidate's features: what Scout filters test and what the Teacher reads. The git half is
 * computed by the worker from the commit, so it is the same every time; the text half comes from
 * what the Scout submitted (title, labels, PR and issue text, its rank).
 */

export interface ScoutExtras {
  title?: string | null;
  labels?: string[] | null;
  issue?: number | null;
  pr_body?: string | null;
  issue_body?: string | null;
  rank?: number | null;
}

/** Git features of one commit, or null when the commit is not a usable unit (the check says why). */
export type GitFeatures = (repo: string, sha: string) => Promise<CandidateFeatures | null>;

const DAY_MS = 86_400_000;
const headDates = new Map<string, string>();

async function headDate(dir: string, head: string): Promise<string> {
  const cached = headDates.get(head);
  if (cached) return cached;
  const date = (await describeUnit(dir, head)).date;
  headDates.set(head, date);
  return date;
}

/** From the blobless clone: files and lines touched, and age relative to HEAD. */
export const gitFeatures: GitFeatures = async (repo, sha) => {
  const unit = await candidateFromUnit(repo, sha);
  if (!unit.ok) return null;
  const { candidate } = unit;
  const clone = await ensureClone(repo);
  const profile = profileFor(repo);
  let testLines = 0;
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const entry of (await numstat(clone.dir, [candidate.sha])).get(candidate.sha) ?? []) {
    const kind = classify(profile, entry.path);
    if (kind === 'test') testLines += entry.added + entry.deleted;
    else if (kind !== 'doc') {
      linesAdded += entry.added;
      linesDeleted += entry.deleted;
    }
  }
  const added = new Set((await describeUnit(clone.dir, candidate.sha)).files.filter((f) => f.status.startsWith('A')).map((f) => f.path));
  const head = await headDate(clone.dir, clone.head);
  const age = Math.round((Date.parse(head) - Date.parse(candidate.date)) / DAY_MS);
  return {
    fix_date: candidate.date,
    age_days: Number.isFinite(age) ? Math.max(0, age) : null,
    files: candidate.source_files.length + candidate.test_files.length + candidate.other_files.length,
    source_file_count: candidate.source_files.length,
    test_file_count: candidate.test_files.length,
    source_files: candidate.source_files,
    test_files: candidate.test_files,
    other_files: candidate.other_files,
    new_test_files: candidate.test_files.filter((path) => added.has(path)).length,
    new_source_files: candidate.source_files.filter((path) => added.has(path)).length,
    non_test_lines: candidate.non_test_lines,
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    test_lines: testLines,
  };
};

/** Leading emoji or `:code:` of a title, empty when there is none. */
export function titlePrefix(title: string): string {
  const match = /^(?::[a-z0-9_+-]+:|[^\p{L}\p{N}`'"([\s])+/u.exec(title.trim());
  return match ? match[0].trim() : '';
}

export function textFeatures(extras: ScoutExtras): CandidateFeatures {
  const title = extras.title ?? '';
  return {
    title,
    title_prefix: titlePrefix(title),
    labels: Array.isArray(extras.labels) ? extras.labels.filter((label): label is string => typeof label === 'string') : null,
    has_issue: typeof extras.issue === 'number' && extras.issue > 0,
    pr_body_chars: (extras.pr_body ?? '').length,
    issue_body_chars: (extras.issue_body ?? '').length,
    scout_rank: typeof extras.rank === 'number' ? extras.rank : null,
  };
}

/** Labels and rank by sha, from the raw list the Scout submitted (parseCandidates drops labels). */
export function extrasFromRaw(raw: unknown[]): Map<string, { labels: string[] | null; rank: number }> {
  const out = new Map<string, { labels: string[] | null; rank: number }>();
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    const sha = typeof record.sha === 'string' ? record.sha.trim() : '';
    if (!sha || out.has(sha)) return;
    const labels = Array.isArray(record.labels)
      ? record.labels.map((label) => (typeof label === 'string' ? label : typeof (label as { name?: unknown })?.name === 'string' ? String((label as { name: string }).name) : null)).filter((label): label is string => Boolean(label))
      : null;
    out.set(sha, { labels, rank: index + 1 });
  });
  return out;
}
