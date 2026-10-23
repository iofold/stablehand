// Step 1: mine candidate fix commits from a blobless clone and measure the repo's suite.
import { join } from 'node:path';
import { MAX_FILES, MAX_NON_TEST_LINES, RESULTS_DIR, SINCE } from './config.ts';
import { buildEnv } from './build-env.ts';
import type { EnvBuildResult } from './build-env.ts';
import { headBaseline } from './check-candidate.ts';
import { ensureClone, listCommits, numstat } from './git.ts';
import type { CommitRecord } from './git.ts';
import { classify, isTestModule, looksLikeFix, profileFor, touchesSkipPath } from './repos.ts';
import { log, secs, writeJson } from './util.ts';

export interface Candidate {
  repo: string;
  sha: string;
  parent: string;
  date: string;
  author: string;
  subject: string;
  source_files: string[];
  test_files: string[];
  other_files: string[];
  doc_files: string[];
  non_test_lines: number;
}

export interface SuiteMeasure {
  seconds: number;
  passed: number;
  failed: number;
  timed_out: boolean;
}

export interface RepoScout {
  repo: string;
  slug: string;
  head: string;
  since: string;
  /** How many commits survive each filter, in order. */
  funnel: Record<string, number>;
  candidates: number;
  candidate_list: Candidate[];
  env?: Pick<EnvBuildResult, 'ok' | 'reason' | 'tag' | 'build_seconds' | 'size_bytes' | 'collected_tests'>;
  suite?: SuiteMeasure;
  score: number;
  timings: Record<string, number>;
}

/** Tree-level filters (no blob fetches): fix-like message, touches source and tests, small file count. */
function treeFilter(repo: string, c: CommitRecord, funnel: Record<string, number>): Candidate | null {
  const profile = profileFor(repo);
  const bump = (k: string) => (funnel[k] = (funnel[k] ?? 0) + 1);
  if (c.parents.length === 0 || /^revert\b/i.test(c.title)) return null;
  bump('not_revert');
  if (!looksLikeFix(c.title)) return null;
  bump('fix_like_message');
  const source: string[] = [];
  const tests: string[] = [];
  const other: string[] = [];
  const docs: string[] = [];
  for (const f of c.files) {
    if (touchesSkipPath(profile, f.path)) return null;
    const kind = classify(profile, f.path);
    if (kind === 'source') source.push(f.path);
    else if (kind === 'test') tests.push(f.path);
    else if (kind === 'doc') docs.push(f.path);
    else other.push(f.path);
  }
  if (!source.some((p) => /\.pyi?$/.test(p)) || !tests.some(isTestModule)) return null;
  bump('touches_source_and_tests');
  if (source.length + tests.length + other.length > MAX_FILES) return null;
  bump(`files_le_${MAX_FILES}`);
  return {
    repo,
    sha: c.sha,
    parent: c.parents[0],
    date: c.date,
    author: c.author,
    subject: c.title,
    source_files: source,
    test_files: tests,
    other_files: other,
    doc_files: docs,
    non_test_lines: 0,
  };
}

/** Mine candidates only (no Docker). */
export async function mineCandidates(repo: string): Promise<{ head: string; funnel: Record<string, number>; candidates: Candidate[]; timings: Record<string, number> }> {
  const timings: Record<string, number> = {};
  let t0 = Date.now();
  const clone = await ensureClone(repo);
  timings.clone_seconds = secs(clone.cloneMs || Date.now() - t0);
  t0 = Date.now();
  const commits = await listCommits(clone.dir, SINCE);
  const funnel: Record<string, number> = { commits_since: commits.length };
  const stage1 = commits.map((c) => treeFilter(repo, c, funnel)).filter((c): c is Candidate => c !== null);
  timings.log_seconds = secs(Date.now() - t0);

  // Line counts need blobs; fetch them only for the survivors.
  t0 = Date.now();
  const stats = await numstat(clone.dir, stage1.map((c) => c.sha));
  timings.numstat_seconds = secs(Date.now() - t0);
  const profile = profileFor(repo);
  const candidates: Candidate[] = [];
  for (const c of stage1) {
    const entries = stats.get(c.sha) ?? [];
    let lines = 0;
    let binarySource = false;
    for (const e of entries) {
      const kind = classify(profile, e.path);
      if (kind === 'test' || kind === 'doc') continue;
      if (e.binary) binarySource = true;
      lines += e.added + e.deleted;
    }
    if (binarySource || lines > MAX_NON_TEST_LINES) continue;
    c.non_test_lines = lines;
    candidates.push(c);
  }
  funnel[`non_test_lines_le_${MAX_NON_TEST_LINES}`] = candidates.length;
  return { head: clone.head, funnel, candidates, timings };
}

export async function scoutRepo(repo: string, opts: { measureSuite: boolean; suiteTimeoutMs: number }): Promise<RepoScout> {
  const profile = profileFor(repo);
  const mined = await mineCandidates(repo);
  log('scout', `${repo}: ${mined.funnel.commits_since} commits since ${SINCE} -> ${mined.candidates.length} candidates`);
  writeJson(join(RESULTS_DIR, profile.slug, 'candidates.json'), mined.candidates);
  const out: RepoScout = {
    repo,
    slug: profile.slug,
    head: mined.head,
    since: SINCE,
    funnel: mined.funnel,
    candidates: mined.candidates.length,
    candidate_list: mined.candidates,
    score: 0,
    timings: mined.timings,
  };
  if (opts.measureSuite) {
    const env = await buildEnv(repo);
    out.env = { ok: env.ok, reason: env.reason, tag: env.tag, build_seconds: env.build_seconds, size_bytes: env.size_bytes, collected_tests: env.collected_tests };
    out.timings.env_build_seconds = env.build_seconds;
    if (env.ok) {
      const base = await headBaseline(repo, env, { repeats: 1, timeoutMs: opts.suiteTimeoutMs });
      const r = base.runs[0];
      out.suite = { seconds: r.seconds, passed: r.passed, failed: r.failed, timed_out: r.timed_out };
      out.timings.suite_seconds = r.seconds;
    }
  }
  out.score = scoreRepo(out);
  writeJson(join(RESULTS_DIR, profile.slug, 'scout.json'), { ...out, candidate_list: undefined });
  return out;
}

/** Candidates count fully when the suite runs green-ish in under 2 minutes; slow or broken suites are discounted. */
export function scoreRepo(s: RepoScout): number {
  if (!s.suite) return s.env && !s.env.ok ? 0 : s.candidates * 0.5;
  if (s.suite.timed_out || s.suite.passed === 0) return 0;
  const speed = s.suite.seconds <= 120 ? 1 : Math.max(0.1, 120 / s.suite.seconds) ** 2;
  return Math.round(s.candidates * speed * 10) / 10;
}

export async function scout(repos: string[], opts: { measureSuite: boolean; suiteTimeoutMs: number }): Promise<RepoScout[]> {
  const results: RepoScout[] = [];
  for (const repo of repos) {
    try {
      results.push(await scoutRepo(repo, opts));
    } catch (e) {
      log('scout', `${repo}: failed: ${String(e).slice(0, 400)}`);
      results.push({ repo, slug: profileFor(repo).slug, head: '', since: SINCE, funnel: {}, candidates: 0, candidate_list: [], score: 0, timings: {} });
    }
  }
  results.sort((a, b) => b.score - a.score);
  writeJson(join(RESULTS_DIR, 'scout.json'), {
    generated_at: new Date().toISOString(),
    since: SINCE,
    pick: results[0]?.repo,
    ranked: results.map((r) => ({ ...r, candidate_list: undefined })),
  });
  return results;
}
