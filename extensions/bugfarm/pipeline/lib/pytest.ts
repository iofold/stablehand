// Pytest invocation and output parsing. Outcomes come from the short test summary (`-r` with `p`
// for passes), which prints exact node ids without any plugin. Verbose per-test lines are the
// fallback when the interpreter dies (segfault, os._exit) before the summary is printed. The task
// verifier (templates/grade.py) uses the same flags and parser, so ids always match.
import { runInTree } from './docker.ts';

export type Outcome = 'passed' | 'failed' | 'error' | 'xfailed' | 'xpassed';

export interface PytestRun {
  outcomes: Map<string, Outcome>;
  /** Test modules that failed to import/collect (`ERROR path - ...` with no `::`). */
  collectionErrors: string[];
  /** Tests that killed the interpreter; recorded as `error` and deselected on the retry. */
  crashed: string[];
  skipped: number;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  tail: string;
  /** The last run's combined output, capped at OUTPUT_KEEP_BYTES from the end. */
  output: string;
}

const OUTPUT_KEEP_BYTES = 64 * 1024;

/**
 * Flags for every run. Output-rewriting plugins (sugar, pretty) are blocked so the format is stable;
 * collection errors must not abort the run (pytest's default is to run nothing at all); `-v` with the
 * classic style prints `<nodeid> <OUTCOME>` per test as it finishes.
 */
export const PYTEST_FLAGS = [
  '-p', 'no:cacheprovider', '-p', 'no:randomly', '-p', 'no:sugar', '-p', 'no:pretty',
  '-v', '-rfEXxp', '--color=no', '--continue-on-collection-errors', '-o', 'console_output_style=classic',
];

const SUMMARY_RE = /^(PASSED|FAILED|ERROR|XFAIL|XPASS) (.+)$/;
const VERBOSE_RE = /^(\S[^\n]*?::[^\n]*?) (PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)(?: \(.*\))?\s*$/;
const OUTCOME: Record<string, Outcome> = { PASSED: 'passed', FAILED: 'failed', ERROR: 'error', XFAIL: 'xfailed', XPASS: 'xpassed' };

function worse(prev: Outcome | undefined, next: Outcome): Outcome {
  return !prev || prev === 'passed' ? next : prev;
}

export function parseOutput(text: string): { outcomes: Map<string, Outcome>; collectionErrors: string[]; skipped: number; crashedAt?: string; hasSummary: boolean } {
  const summary = new Map<string, Outcome>();
  const verbose = new Map<string, Outcome>();
  const collectionErrors: string[] = [];
  let skipped = 0;
  let hasSummary = false;
  let lastStarted: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const s = SUMMARY_RE.exec(line);
    if (s) {
      hasSummary = true;
      let rest = s[2];
      if (s[1] !== 'PASSED' && s[1] !== 'XPASS') {
        const sep = rest.indexOf(' - ');
        if (sep > 0) rest = rest.slice(0, sep);
      }
      const id = rest.trim();
      if (s[1] === 'ERROR' && !id.includes('::')) collectionErrors.push(id);
      else summary.set(id, worse(summary.get(id), OUTCOME[s[1]]));
      continue;
    }
    const v = VERBOSE_RE.exec(line);
    if (v) {
      lastStarted = undefined;
      if (v[2] === 'SKIPPED') skipped++;
      else verbose.set(v[1], worse(verbose.get(v[1]), OUTCOME[v[2]]));
      continue;
    }
    // A bare node id is a test that started and never reported (the line the crash interrupted).
    if (/^\S[^ ]*::\S/.test(line) && !line.includes(' - ')) lastStarted = line.trim();
  }
  const outcomes = hasSummary ? summary : verbose;
  if (hasSummary) for (const [id, o] of verbose) if (!outcomes.has(id)) outcomes.set(id, o);
  return { outcomes, collectionErrors, skipped, crashedAt: hasSummary ? undefined : lastStarted, hasSummary };
}

async function runOnce(opts: { image: string; treeDir: string; args: string[]; timeoutMs: number; tb: string }) {
  const r = await runInTree({
    image: opts.image,
    treeDir: opts.treeDir,
    command: ['python', '-m', 'pytest', ...PYTEST_FLAGS, `--tb=${opts.tb}`, ...opts.args],
    timeoutMs: opts.timeoutMs,
  });
  return { r, text: r.stdout + '\n' + r.stderr };
}

/**
 * Run pytest; if the interpreter dies mid-run, record the test it died in as `error`, deselect it
 * and rerun (up to `maxCrashes` times), merging outcomes.
 */
export async function runPytest(opts: { image: string; treeDir: string; args: string[]; timeoutMs: number; tb?: 'no' | 'short' | 'line'; maxCrashes?: number }): Promise<PytestRun> {
  const outcomes = new Map<string, Outcome>();
  const collectionErrors = new Set<string>();
  const crashed: string[] = [];
  let skipped = 0;
  let ms = 0;
  let last: Awaited<ReturnType<typeof runOnce>> | undefined;
  const deadline = Date.now() + opts.timeoutMs;
  for (let attempt = 0; attempt <= (opts.maxCrashes ?? 3); attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const deselect = crashed.flatMap((id) => ['--deselect', id]);
    last = await runOnce({ ...opts, args: [...opts.args, ...deselect], timeoutMs: remaining, tb: opts.tb ?? 'no' });
    ms += last.r.ms;
    const p = parseOutput(last.text);
    for (const [id, o] of p.outcomes) outcomes.set(id, o);
    for (const e of p.collectionErrors) collectionErrors.add(e);
    skipped += p.skipped;
    if (last.r.timedOut || p.hasSummary || !p.crashedAt || crashed.includes(p.crashedAt)) break;
    crashed.push(p.crashedAt);
    outcomes.set(p.crashedAt, 'error');
  }
  const text = last?.text ?? '';
  return {
    outcomes,
    collectionErrors: [...collectionErrors],
    crashed,
    skipped,
    exitCode: last?.r.code ?? null,
    timedOut: last?.r.timedOut ?? false,
    ms,
    tail: text.split('\n').slice(-40).join('\n'),
    output: text.length > OUTPUT_KEEP_BYTES ? text.slice(-OUTPUT_KEEP_BYTES) : text,
  };
}

export async function collectOnly(opts: { image: string; treeDir: string; args: string[]; timeoutMs: number }): Promise<{ count: number; errors: string[]; ms: number; ok: boolean; tail: string }> {
  const r = await runInTree({
    image: opts.image,
    treeDir: opts.treeDir,
    command: ['python', '-m', 'pytest', '--collect-only', '-q', '-p', 'no:cacheprovider', '-p', 'no:sugar', '-p', 'no:pretty', '--continue-on-collection-errors', ...opts.args],
    timeoutMs: opts.timeoutMs,
  });
  const text = r.stdout + '\n' + r.stderr;
  const ids = text.split('\n').filter((l) => l.includes('::') && !l.startsWith('ERROR'));
  const errors = text.split('\n').filter((l) => /^ERROR /.test(l)).map((l) => l.slice(6).split(' - ')[0]);
  return { count: ids.length, errors, ms: r.ms, ok: (r.code === 0 || r.code === 1) && ids.length > 0, tail: text.split('\n').slice(-30).join('\n') };
}
