// Per-repo profiles for the shortlist: where source and tests live, and a hand-written env Dockerfile.
// The agent-driven version replaces `dockerfile` with an Env-builder agent's output; everything else
// in the pipeline only depends on the profile shape.

export interface RepoProfile {
  repo: string; // owner/name
  slug: string; // short name used in tags and task names
  /** Package source roots. A candidate fix must touch at least one file here; these dirs are the verifier's artifacts. */
  sourceDirs: string[];
  /** Test roots (anything under them counts as a test file, including snapshots and data). */
  testDirs: string[];
  /** Commits touching these prefixes are skipped (e.g. compiled code the env cannot rebuild). */
  skipPaths: string[];
  /** Full-suite pytest targets and flags, run from /app. */
  suiteArgs: string[];
  /** Env Dockerfile; the build context is the repo tree at HEAD (no .git). */
  dockerfile: string;
}

/** Shared prefix: slim Python, git + patch for solve.sh, no pip cache so no stray wheels of the package. */
function pythonBase(version = '3.12'): string {
  return [
    `FROM python:${version}-slim`,
    'LABEL bugfarm=1',
    'ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1',
    'RUN apt-get update && apt-get install -y --no-install-recommends git patch && rm -rf /var/lib/apt/lists/* && pip install -U pip',
    'WORKDIR /app',
    'COPY . /app',
  ].join('\n');
}

/** Shared suffix: Harbor log dirs exist up front (an image without /logs/verifier breaks reward writes). */
const LOG_DIRS = 'RUN mkdir -p /logs/verifier /logs/agent /logs/artifacts && rm -rf /root/.cache';

export const PROFILES: Record<string, RepoProfile> = {
  'Textualize/rich': {
    repo: 'Textualize/rich',
    slug: 'rich',
    sourceDirs: ['rich'],
    testDirs: ['tests'],
    skipPaths: [],
    suiteArgs: ['tests'],
    dockerfile: [
      pythonBase(),
      'RUN pip install -e . "pytest>=8,<9" attrs "typing-extensions>=4,<5"',
      LOG_DIRS,
    ].join('\n'),
  },
  'encode/httpx': {
    repo: 'encode/httpx',
    slug: 'httpx',
    sourceDirs: ['httpx'],
    testDirs: ['tests'],
    skipPaths: [],
    suiteArgs: ['tests'],
    dockerfile: [
      pythonBase(),
      'RUN pip install -e ".[brotli,cli,http2,socks,zstd]" chardet==5.2.0 pytest==8.4.1 trio==0.31.0 trustme==1.2.1 uvicorn==0.35.0 cryptography==45.0.7',
      LOG_DIRS,
    ].join('\n'),
  },
  'pydantic/pydantic': {
    repo: 'pydantic/pydantic',
    slug: 'pydantic',
    sourceDirs: ['pydantic'],
    testDirs: ['tests'],
    // The Rust core lives in-repo now; the env installs the released wheel, so core fixes cannot be replayed.
    skipPaths: ['pydantic-core/', 'tests/pydantic_core/'],
    suiteArgs: ['tests', '--ignore=tests/pydantic_core', '--ignore=tests/mypy', '--ignore=tests/benchmarks', '--ignore=tests/test_docs.py'],
    dockerfile: [
      pythonBase(),
      'RUN pip install -e . --group dev && pip uninstall -y pytest-pretty pytest-codspeed',
      LOG_DIRS,
    ].join('\n'),
  },
  'python-attrs/attrs': {
    repo: 'python-attrs/attrs',
    slug: 'attrs',
    sourceDirs: ['src/attr', 'src/attrs'],
    testDirs: ['tests'],
    skipPaths: [],
    suiteArgs: ['tests'],
    dockerfile: [
      pythonBase(),
      // hatch-vcs needs a version without .git.
      'ENV SETUPTOOLS_SCM_PRETEND_VERSION=26.1.0',
      'RUN pip install -e . --group tests',
      LOG_DIRS,
    ].join('\n'),
  },
  'fastapi/fastapi': {
    repo: 'fastapi/fastapi',
    slug: 'fastapi',
    sourceDirs: ['fastapi'],
    testDirs: ['tests'],
    skipPaths: [],
    suiteArgs: ['tests', '--ignore=tests/benchmarks', '--ignore=tests/memory_benchmarks'],
    dockerfile: [
      pythonBase(),
      'RUN pip install -e ".[all]" --group tests && pip uninstall -y pytest-sugar pytest-codspeed',
      LOG_DIRS,
    ].join('\n'),
  },
  'Textualize/textual': {
    repo: 'Textualize/textual',
    slug: 'textual',
    sourceDirs: ['src/textual'],
    testDirs: ['tests'],
    skipPaths: [],
    suiteArgs: ['tests'],
    dockerfile: [
      pythonBase(),
      'RUN pip install -e ".[syntax]" "pytest>=8.3,<9" pytest-asyncio pytest-xdist pytest-textual-snapshot httpx',
      LOG_DIRS,
    ].join('\n'),
  },
};

/** Build steps that only this pipeline's task Dockerfiles contain (see package-task.ts). */
export const TASK_BUILD_STEPS = ['COPY bugfarm-repo/ /app/', 'rm -rf /app/.git && mkdir -p /logs/verifier /logs/agent /logs/artifacts'];

/** Build steps that only this pipeline's env Dockerfiles contain: every RUN line of every profile. */
export function envBuildSteps(): string[] {
  const steps = new Set<string>();
  for (const p of Object.values(PROFILES)) {
    for (const line of p.dockerfile.split('\n')) if (line.startsWith('RUN ')) steps.add(line.slice(4));
  }
  return [...steps];
}

export function profileFor(repo: string): RepoProfile {
  const p = PROFILES[repo];
  if (!p) throw new Error(`no profile for ${repo}; known: ${Object.keys(PROFILES).join(', ')}`);
  return p;
}

export type FileKind = 'source' | 'test' | 'doc' | 'other';

const DOC_RE = /(^|\/)(docs?|changelog\.d|news|\.github)\/|(^|\/)(CHANGELOG|HISTORY|CHANGES|README|CONTRIBUTING)[^/]*$|\.(md|rst)$/i;
const TEST_FILE_RE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/;

function under(path: string, dirs: string[]): boolean {
  return dirs.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`));
}

export function classify(profile: RepoProfile, path: string): FileKind {
  if (under(path, profile.testDirs) || TEST_FILE_RE.test(path)) return 'test';
  if (under(path, profile.sourceDirs)) return 'source';
  if (DOC_RE.test(path)) return 'doc';
  return 'other';
}

/** A python test module pytest can run directly (not conftest, not data). */
export function isTestModule(path: string): boolean {
  return /\.py$/.test(path) && !/(^|\/)(conftest|__init__)\.py$/.test(path);
}

export function touchesSkipPath(profile: RepoProfile, path: string): boolean {
  return profile.skipPaths.some((p) => path.startsWith(p));
}

const FIX_RE = /\b(fix(e[sd]|ing)?|bug(fix)?|regression|crash(es|ed)?|broken|incorrect(ly)?|wrong|error|exception|handle[sd]?|prevent(s|ed)?|resolve[sd]?|correct(s|ed|ly)?)\b/i;
const NOT_FIX_RE = /^(revert|merge)\b|\b(typo|bump|release|changelog)\b/i;

export function looksLikeFix(subject: string): boolean {
  return FIX_RE.test(subject) && !NOT_FIX_RE.test(subject);
}
