// Git plumbing over blobless clones. Tree-only queries (name-status) never fetch blobs;
// numstat and diffs fetch blobs on demand, so they run only on the filtered candidates.
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
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
    '--format=%x1e%H%x1f%P%x1f%aI%x1f%an%x1f%s%x1f%b%x1d', '--name-status', 'HEAD',
  ], { timeoutMs: 5 * 60_000 });
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
