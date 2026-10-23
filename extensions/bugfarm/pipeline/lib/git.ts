// Git plumbing over blobless clones. Tree-only queries (name-status) never fetch blobs;
// numstat and diffs fetch blobs on demand, so they run only on the filtered candidates.
import { dirname, join } from 'node:path';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { CLONES_DIR } from './config.ts';
import { ensureDir, fileExists, log, run, runOk } from './util.ts';

export interface FileChange {
  status: string; // A, M, D, T
  path: string;
}

export interface CommitRecord {
  sha: string;
  parents: string[];
  date: string;
  author: string;
  subject: string;
  /** PR title for merge commits (first body line), else the subject. */
  title: string;
  files: FileChange[];
}

const MERGE_SUBJECT_RE = /^Merge (pull request|branch|remote-tracking branch)\b/;

export interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

export function cloneDir(repo: string): string {
  return join(CLONES_DIR, repo.replace('/', '__'));
}

/** Blobless clone (`--filter=blob:none`). Reuses an existing clone so HEAD stays pinned across runs. */
export async function ensureClone(repo: string): Promise<{ dir: string; head: string; cloneMs: number }> {
  const dir = cloneDir(repo);
  let cloneMs = 0;
  if (!fileExists(join(dir, '.git'))) {
    ensureDir(CLONES_DIR);
    log('git', `cloning ${repo} (blobless)`);
    const t0 = Date.now();
    await runOk('git', ['clone', '--quiet', '--filter=blob:none', `https://github.com/${repo}.git`, dir], { timeoutMs: 15 * 60_000 });
    cloneMs = Date.now() - t0;
  }
  const head = (await runOk('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim();
  return { dir, head, cloneMs };
}

/**
 * Units of change on HEAD's first-parent history since `since`, with changed paths (no blob fetches).
 * A merge commit is one unit (its net diff against the first parent, titled by the PR title), so
 * work-in-progress commits on merged branches never become candidates: their diffs were often
 * superseded before the merge and no longer reverse-apply at HEAD.
 */
export async function listCommits(dir: string, since: string): Promise<CommitRecord[]> {
  const out = await runOk('git', [
    '-C', dir, 'log', '--first-parent', '--diff-merges=first-parent', '--no-renames', `--since=${since}`,
    `--format=${LOG_FORMAT}`, '--name-status', 'HEAD',
  ], { timeoutMs: 5 * 60_000 });
  return parseLogRecords(out);
}

const LOG_FORMAT = '%x1e%H%x1f%P%x1f%aI%x1f%an%x1f%s%x1f%b%x1d';

/**
 * One unit of change (a squash commit, or a merge's net diff against its first parent titled by
 * the PR title), with its changed paths. This is how a pull request the Scout picked becomes a
 * candidate.
 */
export async function describeUnit(dir: string, sha: string): Promise<CommitRecord> {
  const out = await runOk('git', [
    '-C', dir, 'log', '-1', '--diff-merges=first-parent', '--no-renames', `--format=${LOG_FORMAT}`, '--name-status', sha,
  ], { timeoutMs: 5 * 60_000 });
  const [unit] = parseLogRecords(out);
  if (!unit) throw new Error(`no commit ${sha} in ${dir}`);
  return unit;
}

/** Make sure `sha` is in the clone, fetching once when a newer merge is missing. False if it never arrives. */
export async function ensureCommit(dir: string, sha: string): Promise<boolean> {
  const has = async () => (await run('git', ['-C', dir, 'cat-file', '-e', `${sha}^{commit}`])).code === 0;
  if (await has()) return true;
  await run('git', ['-C', dir, 'fetch', '--quiet', '--filter=blob:none', 'origin'], { timeoutMs: 10 * 60_000 });
  return has();
}

/** True when `sha` is an ancestor of (or equal to) `head`. */
export async function isAncestor(dir: string, sha: string, head: string): Promise<boolean> {
  return (await run('git', ['-C', dir, 'merge-base', '--is-ancestor', sha, head])).code === 0;
}

function parseLogRecords(out: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const end = rec.indexOf('\x1d');
    const [sha, parents, date, author, subject, body] = rec.slice(0, end).split('\x1f');
    const files: FileChange[] = [];
    for (const line of rec.slice(end + 1).split('\n')) {
      if (!line.trim()) continue;
      const [status, ...p] = line.split('\t');
      files.push({ status: status.trim(), path: p.join('\t') });
    }
    const parentList = parents ? parents.split(' ') : [];
    const firstBodyLine = (body ?? '').split('\n').map((l) => l.trim()).find(Boolean);
    const title = parentList.length > 1 && MERGE_SUBJECT_RE.test(subject) && firstBodyLine ? firstBodyLine : subject;
    commits.push({ sha, parents: parentList, date, author, subject, title, files });
  }
  return commits;
}

/** Drop the "Merge pull request #N from ..." line so the PR title leads. */
export function stripMergeSubject(message: string): string {
  const lines = message.split('\n');
  return MERGE_SUBJECT_RE.test(lines[0] ?? '') ? lines.slice(1).join('\n').trim() : message;
}

/** Line counts per file for a batch of commits. Triggers lazy blob fetches for exactly these commits. */
export async function numstat(dir: string, shas: string[]): Promise<Map<string, NumstatEntry[]>> {
  const result = new Map<string, NumstatEntry[]>();
  const batch = 200;
  for (let i = 0; i < shas.length; i += batch) {
    const chunk = shas.slice(i, i + batch);
    const out = await runOk('git', [
      '-C', dir, 'log', '--no-walk=unsorted', '--diff-merges=first-parent', '--no-renames', '--numstat', '--format=%x1e%H', ...chunk,
    ], { timeoutMs: 20 * 60_000 });
    for (const rec of out.split('\x1e')) {
      if (!rec.trim()) continue;
      const [sha, ...lines] = rec.split('\n');
      const entries: NumstatEntry[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const [a, d, ...p] = line.split('\t');
        const binary = a === '-' || d === '-';
        entries.push({ path: p.join('\t'), added: binary ? 0 : Number(a), deleted: binary ? 0 : Number(d), binary });
      }
      result.set(sha.trim(), entries);
    }
  }
  return result;
}

/** Unified diff of `sha` against its first parent, limited to `paths`. Empty string when paths is empty. */
export async function diffPaths(dir: string, sha: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return '';
  return runOk('git', ['-C', dir, 'diff', '--binary', '--no-renames', '--full-index', `${sha}^`, sha, '--', ...paths], { timeoutMs: 5 * 60_000 });
}

export async function commitMessage(dir: string, sha: string): Promise<string> {
  return stripMergeSubject((await runOk('git', ['-C', dir, 'log', '-1', '--format=%B', sha])).trim());
}

/** Export a revision's tree to `outDir` (no .git). */
export async function exportTree(dir: string, rev: string, outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  const tar = `${outDir}.tar`;
  await runOk('git', ['-C', dir, 'archive', '--format=tar', '-o', tar, rev], { timeoutMs: 10 * 60_000 });
  try {
    await runOk('tar', ['-xf', tar, '-C', outDir]);
  } finally {
    rmSync(tar, { force: true });
  }
}

/** Text content of `path` at `rev`, or null when the path does not exist there. */
export async function fileAt(dir: string, rev: string, path: string): Promise<string | null> {
  const r = await run('git', ['-C', dir, 'cat-file', '-p', `${rev}:${path}`], { timeoutMs: 5 * 60_000 });
  return r.code === 0 ? r.stdout : null;
}

export type RevertOutcome = { ok: true; content: string | null } | { ok: false; message: string };

/**
 * Revert one file's share of commit `sha` on top of `current` (the file in the tree, null if absent)
 * with a 3-way merge: current = HEAD, base = the fix, other = the fix's parent. This is what
 * `git revert` does per file; unlike `git apply -R` it tolerates context lines that changed since.
 * Returns the new content (null = delete) or the reason it conflicts.
 */
export async function revertFile3Way(cloneDirPath: string, sha: string, path: string, current: string | null, scratchDir: string): Promise<RevertOutcome> {
  const base = await fileAt(cloneDirPath, sha, path);
  const other = await fileAt(cloneDirPath, `${sha}^`, path);
  if (base !== null && other === null) {
    // The fix added this file: drop it if nobody changed it since.
    if (current === null) return { ok: true, content: null };
    return current === base ? { ok: true, content: null } : { ok: false, message: `${path}: added by the fix and changed since` };
  }
  if (base === null && other !== null) {
    // The fix deleted this file: bring it back unless it reappeared since.
    return current === null ? { ok: true, content: other } : { ok: false, message: `${path}: deleted by the fix and re-created since` };
  }
  if (base === null || other === null) return { ok: true, content: current };
  if (current === null) return { ok: false, message: `${path}: deleted since the fix` };
  ensureDir(scratchDir);
  const [cur, bas, oth] = ['current', 'base', 'other'].map((n) => join(scratchDir, n));
  writeFileSync(cur, current);
  writeFileSync(bas, base);
  writeFileSync(oth, other);
  const r = await run('git', ['merge-file', '-p', '-L', 'HEAD', '-L', 'fix', '-L', 'before-fix', cur, bas, oth]);
  if (r.code === 0) return { ok: true, content: r.stdout };
  return { ok: false, message: `${path}: ${r.code !== null && r.code > 0 ? `${r.code} conflicting hunk(s)` : `merge-file failed: ${r.stderr.trim()}`}` };
}

/**
 * A -p1 patch from `fromRoot` to `toRoot` restricted to `paths`, built with `git diff --no-index`
 * over `a/` and `b/` copies so the headers read `a/<path>` / `b/<path>`.
 */
export async function diffTrees(fromRoot: string, toRoot: string, paths: string[], scratchDir: string): Promise<string> {
  rmSync(scratchDir, { recursive: true, force: true });
  for (const [side, root] of [['a', fromRoot], ['b', toRoot]] as const) {
    ensureDir(join(scratchDir, side));
    for (const p of paths) {
      if (fileExists(join(root, p))) cpSync(join(root, p), join(scratchDir, side, p));
    }
  }
  const r = await run('git', ['diff', '--no-index', '--no-prefix', '--binary', 'a', 'b'], { cwd: scratchDir, env: { GIT_CEILING_DIRECTORIES: dirname(scratchDir) } });
  rmSync(scratchDir, { recursive: true, force: true });
  if (r.code !== 0 && r.code !== 1) throw new Error(`git diff --no-index failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * `git apply` inside a plain directory. GIT_CEILING_DIRECTORIES stops git from discovering an
 * enclosing repository (the work dir sits inside the Stablehand checkout), which would otherwise
 * make paths resolve against the wrong root and silently skip files.
 */
export async function applyPatch(treeDir: string, patchFile: string, opts: { reverse?: boolean; check?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const args = ['apply', '--whitespace=nowarn'];
  if (opts.reverse) args.push('-R');
  if (opts.check) args.push('--check');
  args.push(patchFile);
  const r = await run('git', args, { cwd: treeDir, env: { GIT_CEILING_DIRECTORIES: dirname(treeDir) } });
  return { ok: r.code === 0, message: (r.stderr || r.stdout).trim() };
}
