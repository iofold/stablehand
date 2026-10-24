// Step 2: build one environment image per repo at HEAD and confirm pytest collects.
// `buildEnvFromDockerfile` is the seam for the Env-builder agent: Dockerfile text in, logs + verdict out.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, TREES_DIR } from './config.ts';
import { dockerBuild, imageExists, imageSize } from './docker.ts';
import { ensureClone, exportTree } from './git.ts';
import { collectOnly } from './pytest.ts';
import { profileFor } from './repos.ts';
import { fileExists, log, secs, writeJson, writeText } from './util.ts';

export interface EnvBuildResult {
  repo: string;
  head: string;
  tag: string;
  ok: boolean;
  /** Set when ok is false: `env_build_failed` or `env_collect_failed`. */
  reason?: string;
  build_seconds: number;
  size_bytes: number;
  reused: boolean;
  collected_tests: number;
  collection_errors: string[];
  collect_seconds: number;
  logs_path: string;
  dockerfile: string;
}

export function envTag(slug: string, head: string, dockerfile?: string): string {
  const base = `bugfarm/env-${slug}:${head.slice(0, 12)}`;
  // An agent-written Dockerfile gets its own tag, so every attempt is a separate, cacheable image.
  return dockerfile === undefined ? base : `${base}-${createHash('sha256').update(dockerfile).digest('hex').slice(0, 8)}`;
}

export function headTreeDir(slug: string): string {
  return join(TREES_DIR, slug, 'HEAD');
}

/** Export HEAD once per repo; the tree doubles as the build context and as the fixed state for every candidate. */
export async function ensureHeadTree(repo: string): Promise<{ dir: string; head: string; cloneDir: string }> {
  const profile = profileFor(repo);
  const clone = await ensureClone(repo);
  const dir = headTreeDir(profile.slug);
  const stamp = join(TREES_DIR, profile.slug, 'HEAD.sha'); // outside the tree so it never ships
  const current = fileExists(stamp) ? readFileSync(stamp, 'utf8').trim() : '';
  if (current !== clone.head) {
    await exportTree(clone.dir, clone.head, dir);
    writeText(stamp, clone.head + '\n');
  }
  return { dir, head: clone.head, cloneDir: clone.dir };
}

/**
 * Build `dockerfileText` against `contextDir` as `tag`, then run `pytest --collect-only` with `treeDir`
 * mounted the same way every later check mounts it. Pure function of its inputs plus Docker.
 */
export async function buildEnvFromDockerfile(opts: {
  dockerfileText: string;
  contextDir: string;
  treeDir: string;
  tag: string;
  collectArgs: string[];
  force?: boolean;
}): Promise<{ ok: boolean; reason?: string; logs: string; buildMs: number; sizeBytes: number; reused: boolean; collected: number; collectionErrors: string[]; collectMs: number }> {
  let logs = '';
  let buildMs = 0;
  let reused = false;
  if (!opts.force && (await imageExists(opts.tag))) {
    reused = true;
    logs = `reused existing image ${opts.tag}\n`;
  } else {
    const b = await dockerBuild({ dockerfileText: opts.dockerfileText, contextDir: opts.contextDir, tag: opts.tag });
    logs = b.logs;
    buildMs = b.ms;
    if (!b.ok) return { ok: false, reason: 'env_build_failed', logs, buildMs, sizeBytes: 0, reused, collected: 0, collectionErrors: [], collectMs: 0 };
  }
  const c = await collectOnly({ image: opts.tag, treeDir: opts.treeDir, args: opts.collectArgs, timeoutMs: 10 * 60_000 });
  logs += `\n--- pytest --collect-only (tail) ---\n${c.tail}\n`;
  return {
    ok: c.ok,
    reason: c.ok ? undefined : 'env_collect_failed',
    logs,
    buildMs,
    sizeBytes: await imageSize(opts.tag),
    reused,
    collected: c.count,
    collectionErrors: c.errors,
    collectMs: c.ms,
  };
}

/**
 * Harbor's terminus-2 (the calibration solver) drives the task container over tmux, and the task
 * container has no network, so tmux has to be in the env image. The profile Dockerfiles install
 * it; an agent-written Dockerfile that does not gets this layer appended. Without it every
 * calibration attempt fails with "Failed to start tmux session".
 */
export const SOLVER_TOOLS_LAYER = [
  'USER root',
  'RUN command -v tmux >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends tmux && rm -rf /var/lib/apt/lists/*) || apk add --no-cache tmux',
].join('\n');

export function withSolverTools(dockerfile: string): string {
  if (/^\s*RUN\b[^\n]*\btmux\b/im.test(dockerfile)) return dockerfile;
  return `${dockerfile.replace(/\s*$/, '')}\n# Added by Bugfarm: terminus-2 needs tmux in the task container.\n${SOLVER_TOOLS_LAYER}\n`;
}

/** CLI-facing step: build the repo's env image at HEAD from its profile (or an override Dockerfile). */
export async function buildEnv(repo: string, opts: { dockerfileText?: string; force?: boolean } = {}): Promise<EnvBuildResult> {
  const profile = profileFor(repo);
  const head = await ensureHeadTree(repo);
  const custom = opts.dockerfileText !== undefined && opts.dockerfileText !== profile.dockerfile;
  const dockerfile = custom ? withSolverTools(opts.dockerfileText as string) : profile.dockerfile;
  const tag = envTag(profile.slug, head.head, custom ? dockerfile : undefined);
  log('env', `${repo}: building ${tag}`);
  const r = await buildEnvFromDockerfile({
    dockerfileText: dockerfile,
    contextDir: head.dir,
    treeDir: head.dir,
    tag,
    collectArgs: profile.suiteArgs,
    force: opts.force,
  });
  const logsPath = join(RESULTS_DIR, profile.slug, 'env-build.log');
  writeText(logsPath, r.logs);
  const result: EnvBuildResult = {
    repo,
    head: head.head,
    tag,
    ok: r.ok,
    reason: r.reason,
    build_seconds: secs(r.buildMs),
    size_bytes: r.sizeBytes,
    reused: r.reused,
    collected_tests: r.collected,
    collection_errors: r.collectionErrors,
    collect_seconds: secs(r.collectMs),
    logs_path: logsPath,
    dockerfile,
  };
  writeJson(join(RESULTS_DIR, profile.slug, 'env.json'), result);
  log('env', `${repo}: ${r.ok ? 'ok' : r.reason} build=${secs(r.buildMs)}s size=${Math.round(r.sizeBytes / 1e6)}MB collected=${r.collected} errors=${r.collectionErrors.length}`);
  return result;
}

const CONTEXT_FILES = ['pyproject.toml', 'setup.cfg', 'setup.py', 'tox.ini', 'noxfile.py', '.python-version', 'pytest.ini', 'Makefile'];
const MAX_CONTEXT_FILE_CHARS = 6000;

export interface EnvContext {
  repo: string;
  head: string;
  top_level: string[];
  files: Record<string, string>;
  test_dirs: Record<string, string[]>;
  suite_args: string[];
  source_dirs: string[];
}

/**
 * What an Env-builder agent needs to write a Dockerfile without network or a checkout: the HEAD
 * tree's top level, its packaging and test config, requirement files and the test layout.
 */
export async function envContext(repo: string): Promise<EnvContext> {
  const profile = profileFor(repo);
  const tree = await ensureHeadTree(repo);
  const root = tree.dir;
  const topLevel = readdirSync(root, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  const files: Record<string, string> = {};
  const wanted = [...CONTEXT_FILES, ...topLevel.filter((n) => /^requirements.*\.txt$/.test(n))];
  for (const sub of ['requirements', 'reqs']) {
    if (topLevel.includes(`${sub}/`)) {
      for (const n of readdirSync(join(root, sub))) if (n.endsWith('.txt') || n.endsWith('.in')) wanted.push(`${sub}/${n}`);
    }
  }
  for (const name of wanted) {
    const path = join(root, name);
    if (!fileExists(path)) continue;
    const text = readFileSync(path, 'utf8');
    files[name] = text.length > MAX_CONTEXT_FILE_CHARS ? `${text.slice(0, MAX_CONTEXT_FILE_CHARS)}\n[...truncated...]` : text;
  }
  const testDirs: Record<string, string[]> = {};
  for (const d of profile.testDirs) {
    const path = join(root, d);
    if (!fileExists(path)) continue;
    const entries = readdirSync(path, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    testDirs[d] = entries.length > 40 ? [...entries.slice(0, 40), `... and ${entries.length - 40} more`] : entries;
  }
  return { repo, head: tree.head, top_level: topLevel, files, test_dirs: testDirs, suite_args: profile.suiteArgs, source_dirs: profile.sourceDirs };
}
