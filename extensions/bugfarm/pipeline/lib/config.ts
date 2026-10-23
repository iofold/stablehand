// Paths and constants shared by every stage.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PIPELINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the pipeline writes lives here (gitignored). Must be absolute for Harbor's --jobs-dir. */
export const WORK_DIR = resolve(process.env.BUGFARM_WORK_DIR ?? join(PIPELINE_DIR, '.work'));
export const CLONES_DIR = join(WORK_DIR, 'clones');
export const TREES_DIR = join(WORK_DIR, 'trees');
export const RESULTS_DIR = join(WORK_DIR, 'results');
export const TASKS_DIR = join(WORK_DIR, 'tasks');
export const JOBS_DIR = join(WORK_DIR, 'jobs');

/**
 * Commits after this date are candidates. Wider than the panel's training cutoffs on purpose: every
 * task records its fix date, so decontamination can filter by cutoff later.
 */
export const SINCE = process.env.BUGFARM_SINCE ?? '2025-07-01';

/** The demo shortlist from the proposal. */
export const SHORTLIST = [
  'Textualize/rich',
  'encode/httpx',
  'pydantic/pydantic',
  'python-attrs/attrs',
  'fastapi/fastapi',
  'Textualize/textual',
];

/** Candidate filter thresholds (step 1). */
export const MAX_NON_TEST_LINES = 30;
export const MAX_FILES = 5;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Hard cap on concurrent containers we start. 4 suits a shared box; a dedicated one can raise it. */
export const MAX_CONTAINERS = envInt('BUGFARM_MAX_CONTAINERS', 4);
/** Harbor's no-network mode adds an egress sidecar per environment, so 2 trials = 4 containers. */
export const HARBOR_CONCURRENCY = envInt('BUGFARM_HARBOR_CONCURRENCY', 2);

/** Harbor version pinned for the spike; 0.24.0 is the only stable 0.24.x on PyPI (2026-10-23). */
export const HARBOR_VERSION = process.env.BUGFARM_HARBOR_VERSION ?? '0.24.0';
/** `uvx` from PATH, or uv's default install location when PATH does not have it (non-login shells). */
const UVX = process.env.BUGFARM_UVX ?? (existsSync(join(homedir(), '.local', 'bin', 'uvx')) ? join(homedir(), '.local', 'bin', 'uvx') : 'uvx');
export const HARBOR_CMD = [UVX, '--from', `harbor==${HARBOR_VERSION}`, 'harbor'];

/** Every image and container the pipeline creates carries this label so cleanup never touches anything else. */
export const LABEL_KEY = 'bugfarm';
export const LABEL = `${LABEL_KEY}=1`;

/** Repeats for the fail-to-pass check; anything inconsistent across repeats is flaky. */
export const F2P_REPEATS = 3;
/** Full-suite repeats at HEAD (the fixed state is shared by every candidate, so it is run once per repo). */
export const HEAD_SUITE_REPEATS = 2;

/**
 * Pass-to-pass is a time-boxed subset, not the full suite: the fix's own test modules plus up to
 * this many related modules (same directory, or named after a touched source module).
 */
export const P2P_EXTRA_MODULES = envInt('BUGFARM_P2P_EXTRA_MODULES', 4);
/** Runs of the subset on the fixed state; a pass-to-pass test must pass in all of them. */
export const P2P_FIXED_REPEATS = 2;

export const PIPELINE_VERSION = 'm1';
