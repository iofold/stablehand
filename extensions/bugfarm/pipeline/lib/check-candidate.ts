// Step 3: turn a candidate commit into a verified fail-to-pass / pass-to-pass pair, or a reject reason.
//
// States (SWE-gen style, so the env built at HEAD never drifts):
//   fixed = HEAD
//   buggy = HEAD with the fix's source diff reverse-applied (tests stay at HEAD, i.e. include the fix's tests)
//   agent = buggy with the fix's test diff reverse-applied too (what the solver sees; the new tests are hidden)
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { F2P_REPEATS, HEAD_SUITE_REPEATS, RESULTS_DIR, TREES_DIR } from './config.ts';
import type { EnvBuildResult } from './build-env.ts';
import { headTreeDir } from './build-env.ts';
import { applyPatch, cloneDir, diffPaths } from './git.ts';
import { runPytest } from './pytest.ts';
import type { Outcome, PytestRun } from './pytest.ts';
import { isTestModule, profileFor } from './repos.ts';
import type { Candidate } from './scout.ts';
import { ensureDir, fileExists, log, readJson, secs, writeJson } from './util.ts';

export type RejectReason =
  | 'env_build_failed'
  | 'reverse_patch_conflict'
  | 'no_test_targets'
  | 'no_fail_to_pass'
  | 'import_error_only'
  | 'flaky'
  | 'timeout'
  | 'check_error';

export interface CheckResult {
  repo: string;
  sha: string;
  subject: string;
  head: string;
  env_image: string;
  accepted: boolean;
  reason?: RejectReason;
  detail?: string;
  test_targets: string[];
  fail_to_pass: string[];
  pass_to_pass: string[];
  flaky_tests: string[];
  /** Fix test files present at HEAD; their HEAD versions are the hidden tests. */
  hidden_test_files: string[];
  /** Fix test files absent at HEAD that the agent tree still has; the verifier deletes them. */
  deleted_test_files: string[];
  buggy_suite?: { seconds: number; passed: number; failed: number; timed_out: boolean };
  timings: Record<string, number>;
  workdir: string;
}

// ---------------------------------------------------------------------------------------------
// HEAD baseline: the full suite on the fixed state, shared by every candidate of a repo.

export interface BaselineRun {
  seconds: number;
  passed: number;
  failed: number;
  timed_out: boolean;
  crashed: string[];
  passing: string[];
}

export interface HeadBaseline {
  format: number;
  repo: string;
  head: string;
  env_image: string;
  /** Tests that kill the interpreter at HEAD; every later suite run (and the verifier) deselects them. */
  deselect: string[];
  runs: BaselineRun[];
}

const BASELINE_FORMAT = 2;

function summarizeRun(r: PytestRun): BaselineRun {
  const passing = [...r.outcomes].filter(([, o]) => o === 'passed').map(([id]) => id).sort();
  const failed = [...r.outcomes.values()].filter((o) => o === 'failed' || o === 'error').length;
  return { seconds: secs(r.ms), passed: passing.length, failed, timed_out: r.timedOut, crashed: r.crashed, passing };
}

/** The repo's full-suite pytest args plus the HEAD crash deselects. */
export function suiteArgsFor(repo: string, base: HeadBaseline): string[] {
  return [...profileFor(repo).suiteArgs, ...base.deselect.flatMap((id) => ['--deselect', id])];
}

export async function headBaseline(repo: string, env: EnvBuildResult, opts: { repeats?: number; timeoutMs: number }): Promise<HeadBaseline> {
  const profile = profileFor(repo);
  const path = join(RESULTS_DIR, profile.slug, 'head-suite.json');
  let base: HeadBaseline = { format: BASELINE_FORMAT, repo, head: env.head, env_image: env.tag, deselect: [], runs: [] };
  if (fileExists(path)) {
    const cached = readJson<HeadBaseline>(path);
    if (cached.format === BASELINE_FORMAT && cached.head === env.head && cached.env_image === env.tag) base = cached;
  }
  const want = opts.repeats ?? HEAD_SUITE_REPEATS;
  while (base.runs.length < want) {
    log('baseline', `${repo}: full suite at HEAD, run ${base.runs.length + 1}/${want}`);
    const r = await runPytest({ image: env.tag, treeDir: headTreeDir(profile.slug), args: suiteArgsFor(repo, base), timeoutMs: opts.timeoutMs });
    const s = summarizeRun(r);
    log('baseline', `${repo}: ${s.passed} passed, ${s.failed} failed in ${s.seconds}s${s.timed_out ? ' (TIMED OUT)' : ''}${s.crashed.length ? ` crashed: ${s.crashed.join(', ')}` : ''}`);
    base.runs.push(s);
    base.deselect = [...new Set([...base.deselect, ...s.crashed])];
    writeJson(path, base);
    if (s.timed_out) break;
  }
  return base;
}

/** Tests that passed in every baseline run. */
export function stablePassing(base: HeadBaseline): Set<string> {
  const usable = base.runs.filter((r) => !r.timed_out);
  if (usable.length === 0) return new Set();
  let acc = new Set(usable[0].passing);
  for (const r of usable.slice(1)) {
    const next = new Set(r.passing);
    acc = new Set([...acc].filter((t) => next.has(t)));
  }
  return acc;
}

// ---------------------------------------------------------------------------------------------

const FAILING: ReadonlySet<Outcome> = new Set<Outcome>(['failed', 'error']);

function moduleOf(testId: string): string {
  return testId.split('::')[0];
}

/** Outcome of `id` in a run, treating tests in modules that failed to import as errors and absent tests as failures. */
function outcomeIn(run: PytestRun, id: string): Outcome {
  const o = run.outcomes.get(id);
  if (o) return o;
  if (run.collectionErrors.includes(moduleOf(id))) return 'error';
  return 'failed';
}

export function candidateDir(slug: string, sha: string): string {
  return join(TREES_DIR, slug, sha.slice(0, 12));
}

export async function checkCandidate(cand: Candidate, env: EnvBuildResult, base: HeadBaseline, opts: { suiteTimeoutMs: number; targetTimeoutMs: number }): Promise<CheckResult> {
  const profile = profileFor(cand.repo);
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const dir = candidateDir(profile.slug, cand.sha);
  const result: CheckResult = {
    repo: cand.repo,
    sha: cand.sha,
    subject: cand.subject,
    head: env.head,
    env_image: env.tag,
    accepted: false,
    test_targets: [],
    fail_to_pass: [],
    pass_to_pass: [],
    flaky_tests: [],
    hidden_test_files: [],
    deleted_test_files: [],
    timings,
    workdir: dir,
  };
  const reject = (reason: RejectReason, detail: string): CheckResult => {
    result.reason = reason;
    result.detail = detail.slice(0, 2000);
    timings.total_seconds = secs(Date.now() - t0);
    writeJson(join(RESULTS_DIR, profile.slug, 'checks', `${cand.sha.slice(0, 12)}.json`), result);
    log('check', `${profile.slug}@${cand.sha.slice(0, 8)} REJECT ${reason}: ${detail.split('\n')[0].slice(0, 120)}`);
    return result;
  };

  if (!env.ok) return reject('env_build_failed', env.reason ?? 'env build failed');
  try {
    // --- trees and patches
    let ts = Date.now();
    rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    const clone = cloneDir(cand.repo);
    const srcPatch = await diffPaths(clone, cand.sha, cand.source_files);
    const testPatch = await diffPaths(clone, cand.sha, cand.test_files);
    writeFileSync(join(dir, 'src.patch'), srcPatch);
    writeFileSync(join(dir, 'test.patch'), testPatch);
    const head = headTreeDir(profile.slug);
    const buggy = join(dir, 'buggy');
    cpSync(head, buggy, { recursive: true });
    const rs = await applyPatch(buggy, join(dir, 'src.patch'), { reverse: true });
    if (!rs.ok) return reject('reverse_patch_conflict', `source diff does not reverse-apply at HEAD: ${rs.message}`);
    const agent = join(dir, 'agent');
    cpSync(buggy, agent, { recursive: true });
    const rt = await applyPatch(agent, join(dir, 'test.patch'), { reverse: true });
    if (!rt.ok) return reject('reverse_patch_conflict', `test diff does not reverse-apply at HEAD: ${rt.message}`);
    result.hidden_test_files = cand.test_files.filter((f) => fileExists(join(head, f)));
    result.deleted_test_files = cand.test_files.filter((f) => !fileExists(join(head, f)) && fileExists(join(agent, f)));
    timings.prepare_seconds = secs(Date.now() - ts);

    // --- fail-to-pass on the fix's own test modules
    // Targets must exist at HEAD and be part of the suite the verifier runs (not under an --ignore).
    const ignored = profile.suiteArgs.filter((a) => a.startsWith('--ignore=')).map((a) => a.slice('--ignore='.length));
    const targets = cand.test_files.filter((f) => isTestModule(f) && fileExists(join(head, f)) && !ignored.some((p) => f === p || f.startsWith(`${p}/`)));
    result.test_targets = targets;
    if (targets.length === 0) return reject('no_test_targets', 'fix touches no test module that exists at HEAD and is in the verifier suite');

    ts = Date.now();
    const buggyRuns: PytestRun[] = [];
    const fixedRuns: PytestRun[] = [];
    const runTargets = (tree: string) => runPytest({ image: env.tag, treeDir: tree, args: targets, timeoutMs: opts.targetTimeoutMs, tb: 'line' });
    buggyRuns.push(await runTargets(buggy));
    fixedRuns.push(await runTargets(head));
    if (buggyRuns[0].timedOut || fixedRuns[0].timedOut) return reject('timeout', 'targeted test run timed out');

    if (buggyRuns[0].outcomes.size === 0 && buggyRuns[0].collectionErrors.length === 0) {
      // pytest never started (conftest import error, usage error): every test would look "missing".
      return reject('import_error_only', `pytest could not start on the buggy state (exit ${buggyRuns[0].exitCode})\n${buggyRuns[0].tail}`);
    }
    const passingFixed = [...fixedRuns[0].outcomes].filter(([, o]) => o === 'passed').map(([id]) => id);
    if (passingFixed.length === 0) {
      return reject('no_fail_to_pass', `no target test passes at HEAD (collection errors: ${fixedRuns[0].collectionErrors.join(', ') || 'none'})\n${fixedRuns[0].tail}`);
    }
    let f2p = passingFixed.filter((id) => FAILING.has(outcomeIn(buggyRuns[0], id)));
    if (f2p.length === 0) return reject('no_fail_to_pass', `all ${passingFixed.length} passing target tests also pass on the buggy state`);

    for (let i = 1; i < F2P_REPEATS; i++) {
      buggyRuns.push(await runTargets(buggy));
      fixedRuns.push(await runTargets(head));
    }
    if ([...buggyRuns, ...fixedRuns].some((r) => r.timedOut)) return reject('timeout', 'targeted test repeat timed out');
    const consistent = f2p.filter((id) => buggyRuns.every((r) => FAILING.has(outcomeIn(r, id))) && fixedRuns.every((r) => r.outcomes.get(id) === 'passed'));
    result.flaky_tests = f2p.filter((id) => !consistent.includes(id));
    f2p = consistent;
    timings.fail_to_pass_seconds = secs(Date.now() - ts);
    if (f2p.length === 0) return reject('flaky', `${result.flaky_tests.length} fail-to-pass tests changed outcome across ${F2P_REPEATS} runs`);

    // Fail-to-pass that only fail because the module cannot import (a new symbol, say) make weak tasks.
    const importOnly = f2p.every((id) => buggyRuns.every((r) => r.collectionErrors.includes(moduleOf(id))));
    if (importOnly) return reject('import_error_only', `all fail-to-pass tests fail at import on the buggy state: ${[...new Set(f2p.map(moduleOf))].join(', ')}`);
    result.fail_to_pass = f2p.sort();

    // --- pass-to-pass: full suite on the buggy state against the cached HEAD baseline
    ts = Date.now();
    const suite = await runPytest({ image: env.tag, treeDir: buggy, args: suiteArgsFor(cand.repo, base), timeoutMs: opts.suiteTimeoutMs });
    timings.pass_to_pass_seconds = secs(Date.now() - ts);
    const suiteSummary = summarizeRun(suite);
    result.buggy_suite = { seconds: suiteSummary.seconds, passed: suiteSummary.passed, failed: suiteSummary.failed, timed_out: suiteSummary.timed_out };
    if (suite.timedOut) return reject('timeout', `buggy full suite exceeded ${secs(opts.suiteTimeoutMs)}s`);
    const stable = stablePassing(base);
    const f2pSet = new Set(f2p);
    result.pass_to_pass = suiteSummary.passing.filter((id) => stable.has(id) && !f2pSet.has(id));

    result.accepted = true;
    timings.total_seconds = secs(Date.now() - t0);
    writeJson(join(RESULTS_DIR, profile.slug, 'checks', `${cand.sha.slice(0, 12)}.json`), result);
    log('check', `${profile.slug}@${cand.sha.slice(0, 8)} OK f2p=${f2p.length} p2p=${result.pass_to_pass.length} (${timings.total_seconds}s)`);
    return result;
  } catch (e) {
    return reject('check_error', String(e));
  } finally {
    // The buggy tree is only needed for checks; the agent tree stays for packaging accepted candidates.
    rmSync(join(dir, 'buggy'), { recursive: true, force: true });
    if (!result.accepted) rmSync(join(dir, 'agent'), { recursive: true, force: true });
  }
}
