// Step 3: turn a candidate commit into a verified fail-to-pass / pass-to-pass pair, or a reject reason.
//
// The env is always the one built at HEAD. The buggy state comes from one of two bases:
//
//   head (SWE-gen style, preferred: no dependency drift)
//     fixed = HEAD
//     buggy = HEAD with the fix's source diff reverted (tests stay at HEAD, so the fix's tests are there)
//     agent = buggy with the fix's test diff reverted too (what the solver sees; the new tests are hidden)
//
//   parent (fallback when the fix no longer reverts at HEAD, even with a 3-way merge)
//     fixed = the fix commit's tree
//     agent = the fix's parent tree
//     buggy = agent with the fix's test files overlaid from the fixed tree
//
// Pass-to-pass is a time-boxed subset, not the full suite: the fix's own test modules plus a few
// related modules, run once on buggy and twice on fixed. A trial then runs in seconds.
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { F2P_REPEATS, HEAD_SUITE_REPEATS, P2P_EXTRA_MODULES, P2P_FIXED_REPEATS, RESULTS_DIR, TREES_DIR } from './config.ts';
import type { EnvBuildResult } from './build-env.ts';
import { headTreeDir } from './build-env.ts';
import { applyPatch, cloneDir, diffPaths, diffTrees, exportTree, isAncestor, revertFile3Way } from './git.ts';
import { runPytest } from './pytest.ts';
import type { Outcome, PytestRun } from './pytest.ts';
import { isTestModule, profileFor } from './repos.ts';
import type { RepoProfile } from './repos.ts';
import type { Candidate } from './scout.ts';
import { ensureDir, fileExists, isDir, log, readJson, secs, writeJson } from './util.ts';

export type RejectReason =
  | 'env_build_failed'
  | 'reverse_patch_conflict'
  | 'no_test_targets'
  | 'no_fail_to_pass'
  | 'import_error_only'
  | 'flaky'
  | 'timeout'
  | 'check_error'
  /** On the parent base, the fixed tree does not even collect on today's env: its dependencies moved on. */
  | 'env_drift';

/** Where the buggy state came from: HEAD with the fix reverted, or the fix's parent commit. */
export type BuggyBase = 'head' | 'parent';

export interface CheckResult {
  repo: string;
  sha: string;
  subject: string;
  head: string;
  env_image: string;
  accepted: boolean;
  reason?: RejectReason;
  detail?: string;
  /** Set once the trees are built. */
  buggy_base?: BuggyBase;
  /** The commit whose tree is the fixed state: HEAD, or the fix itself on the parent base. */
  fixed_ref?: string;
  /** When the fix was committed (ISO-8601). Decontamination filters on it later. */
  fix_date?: string;
  test_targets: string[];
  fail_to_pass: string[];
  pass_to_pass: string[];
  flaky_tests: string[];
  /** Test modules the verifier runs: the fix's own modules plus the related sample. */
  suite_modules: string[];
  /** Tests that crash the interpreter on the fixed state; the verifier deselects them. */
  deselect: string[];
  /** Fix test files present in the fixed tree; their fixed versions are the hidden tests. */
  hidden_test_files: string[];
  /** Fix test files absent from the fixed tree that the agent tree still has; the verifier deletes them. */
  deleted_test_files: string[];
  /** Pytest output for the fail-to-pass tests on the buggy state (what the bug looks like). */
  failing_output?: string;
  buggy_suite?: { seconds: number; passed: number; failed: number; timed_out: boolean };
  /** Seconds of the slowest fixed-state subset run; sizes the verifier timeout. */
  subset_seconds?: number;
  /** `apply` = exact `git apply -R`; `3way` = per-file 3-way revert; `parent` = the fix's parent tree. */
  revert_method?: { source: 'apply' | '3way' | 'parent'; tests: 'apply' | '3way' | 'parent' };
  /** The parent fallback was tried because the revert at HEAD failed with this message. */
  head_revert_failure?: string;
  timings: Record<string, number>;
  workdir: string;
}

// ---------------------------------------------------------------------------------------------
// HEAD baseline: the full suite on the fixed state. Only the scout's repo ranking uses it now.

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
  /** Tests that kill the interpreter at HEAD; every later suite run deselects them. */
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

function passingIn(run: PytestRun): Set<string> {
  return new Set([...run.outcomes].filter(([, o]) => o === 'passed').map(([id]) => id));
}

/**
 * Revert the fix's share of `files` in `tree`: exact `git apply -R` first, then a per-file 3-way
 * merge (what `git revert` does) when later commits moved the context lines.
 */
async function revertInto(tree: string, patchFile: string, sha: string, files: string[], clone: string, scratch: string): Promise<{ ok: true; method: 'apply' | '3way' } | { ok: false; message: string }> {
  const exact = await applyPatch(tree, patchFile, { reverse: true });
  if (exact.ok) return { ok: true, method: 'apply' };
  const updates: Array<{ path: string; content: string | null }> = [];
  for (const f of files) {
    const p = join(tree, f);
    const current = fileExists(p) ? readFileSync(p, 'utf8') : null;
    const r = await revertFile3Way(clone, sha, f, current, scratch);
    if (!r.ok) return { ok: false, message: `git apply -R: ${exact.message.split('\n')[0]}; 3-way: ${r.message}` };
    updates.push({ path: f, content: r.content });
  }
  for (const u of updates) {
    const p = join(tree, u.path);
    if (u.content === null) rmSync(p, { force: true });
    else {
      ensureDir(dirname(p));
      writeFileSync(p, u.content);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  return { ok: true, method: '3way' };
}

export function candidateDir(slug: string, sha: string): string {
  return join(TREES_DIR, slug, sha.slice(0, 12));
}

/** Every pytest module under the profile's test dirs, relative to `tree`. */
export function listTestModules(tree: string, profile: RepoProfile): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/^(test_.*|.*_test)\.py$/.test(entry.name)) out.push(relative(tree, p));
    }
  };
  for (const d of profile.testDirs) if (isDir(join(tree, d))) walk(join(tree, d));
  return out.sort();
}

function stableRank(seed: string, value: string): string {
  return createHash('sha1').update(`${seed}\u0000${value}`).digest('hex');
}

/**
 * The pass-to-pass subset: the fix's own test modules plus up to `extra` related modules. A module
 * is related when it sits beside a target or is named after a touched source module; ties break
 * by a hash of the fix sha, so the same candidate always gets the same sample.
 */
export function selectSubset(opts: {
  modules: string[];
  targets: string[];
  sourceFiles: string[];
  ignored: string[];
  seed: string;
  extra: number;
}): string[] {
  const targetDirs = new Set(opts.targets.map((t) => dirname(t)));
  const stems = opts.sourceFiles
    .map((f) => basename(f).replace(/\.pyi?$/, ''))
    .filter((s) => s.length >= 4 && s !== '__init__' && s !== '__main__')
    .map((s) => s.replace(/^_+/, '').toLowerCase());
  const scored = opts.modules
    .filter((m) => !opts.targets.includes(m) && !opts.ignored.some((p) => m === p || m.startsWith(`${p}/`)))
    .map((m) => {
      const name = basename(m).toLowerCase();
      let score = 0;
      if (targetDirs.has(dirname(m))) score += 1;
      if (stems.some((s) => name.includes(s))) score += 3;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || stableRank(opts.seed, a.m).localeCompare(stableRank(opts.seed, b.m)));
  return [...opts.targets, ...scored.slice(0, Math.max(0, opts.extra)).map((x) => x.m)];
}

/** The FAILURES section of a pytest run, trimmed to the tests that matter; what the bug looks like. */
export function failingOutputFor(run: PytestRun, tests: string[], maxChars = 6000): string {
  const text = run.output;
  const start = text.search(/^=+ FAILURES =+$/m);
  const errors = text.search(/^=+ ERRORS =+$/m);
  const from = start >= 0 ? start : errors;
  let section = from >= 0 ? text.slice(from) : run.tail;
  const end = section.search(/^=+ short test summary info =+$/m);
  if (end > 0) section = section.slice(0, end);
  const names = tests.map((t) => t.split('::').slice(1).join('.').replace(/\[.*$/, ''));
  const blocks = section.split(/^(?=_{3,} .+ _{3,}$)/m).filter((b) => names.some((n) => n && b.includes(n.split('.').pop() ?? n)));
  const chosen = (blocks.length > 0 ? blocks.join('') : section).trim();
  return chosen.length > maxChars ? `${chosen.slice(0, maxChars)}\n[...truncated...]` : chosen;
}

export interface CheckOptions {
  /** Per run of the fix's own test modules. */
  targetTimeoutMs: number;
  /** Per run of the pass-to-pass subset. */
  subsetTimeoutMs: number;
  /** Extra related modules in the subset (default P2P_EXTRA_MODULES). */
  extraModules?: number;
  /** Progress lines for the board ("running the fix's tests on the buggy state"). */
  onProgress?: (message: string) => void;
}

interface Trees {
  base: BuggyBase;
  fixed: string;
  fixedRef: string;
  buggy: string;
  agent: string;
  method: NonNullable<CheckResult['revert_method']>;
}

/** HEAD with the fix reverted. Returns the failure message when the revert conflicts. */
async function headTrees(cand: Candidate, env: EnvBuildResult, dir: string): Promise<Trees | { failure: string }> {
  const profile = profileFor(cand.repo);
  const clone = cloneDir(cand.repo);
  if (!(await isAncestor(clone, cand.sha, env.head))) return { failure: `the fix is not in HEAD ${env.head.slice(0, 12)}` };
  const srcPatch = await diffPaths(clone, cand.sha, cand.source_files);
  const testPatch = await diffPaths(clone, cand.sha, cand.test_files);
  writeFileSync(join(dir, 'src.patch'), srcPatch);
  writeFileSync(join(dir, 'test.patch'), testPatch);
  const head = headTreeDir(profile.slug);
  const buggy = join(dir, 'buggy');
  // verbatimSymlinks: by default cpSync rewrites a relative symlink (pydantic's CONTRIBUTING.md ->
  // docs/contributing.md) into an absolute path back into the source tree.
  cpSync(head, buggy, { recursive: true, verbatimSymlinks: true });
  const rs = await revertInto(buggy, join(dir, 'src.patch'), cand.sha, cand.source_files, clone, join(dir, '.merge'));
  if (!rs.ok) return { failure: `source diff does not revert at HEAD: ${rs.message}` };
  const agent = join(dir, 'agent');
  cpSync(buggy, agent, { recursive: true, verbatimSymlinks: true });
  const rt = await revertInto(agent, join(dir, 'test.patch'), cand.sha, cand.test_files, clone, join(dir, '.merge'));
  if (!rt.ok) return { failure: `test diff does not revert at HEAD: ${rt.message}` };
  return { base: 'head', fixed: head, fixedRef: env.head, buggy, agent, method: { source: rs.method, tests: rt.method } };
}

/** The fix's parent as the buggy state, its own tree as the fixed state, both on the HEAD env. */
async function parentTrees(cand: Candidate, dir: string): Promise<Trees> {
  const clone = cloneDir(cand.repo);
  const fixed = join(dir, 'fixed');
  const agent = join(dir, 'agent');
  const buggy = join(dir, 'buggy');
  await exportTree(clone, cand.sha, fixed);
  await exportTree(clone, cand.parent, agent);
  rmSync(buggy, { recursive: true, force: true });
  cpSync(agent, buggy, { recursive: true, verbatimSymlinks: true });
  for (const f of cand.test_files) {
    const from = join(fixed, f);
    const to = join(buggy, f);
    if (fileExists(from)) {
      ensureDir(dirname(to));
      cpSync(from, to, { verbatimSymlinks: true });
    } else rmSync(to, { force: true });
  }
  return { base: 'parent', fixed, fixedRef: cand.sha, buggy, agent, method: { source: 'parent', tests: 'parent' } };
}

export async function checkCandidate(cand: Candidate, env: EnvBuildResult, opts: CheckOptions): Promise<CheckResult> {
  const profile = profileFor(cand.repo);
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const dir = candidateDir(profile.slug, cand.sha);
  const progress = (message: string) => opts.onProgress?.(message);
  const result: CheckResult = {
    repo: cand.repo,
    sha: cand.sha,
    subject: cand.subject,
    head: env.head,
    env_image: env.tag,
    accepted: false,
    fix_date: cand.date,
    test_targets: [],
    fail_to_pass: [],
    pass_to_pass: [],
    flaky_tests: [],
    suite_modules: [],
    deselect: [],
    hidden_test_files: [],
    deleted_test_files: [],
    timings,
    workdir: dir,
  };
  const save = () => writeJson(join(RESULTS_DIR, profile.slug, 'checks', `${cand.sha.slice(0, 12)}.json`), result);
  const reject = (reason: RejectReason, detail: string): CheckResult => {
    result.reason = reason;
    result.detail = detail.slice(0, 2000);
    timings.total_seconds = secs(Date.now() - t0);
    save();
    log('check', `${profile.slug}@${cand.sha.slice(0, 8)} REJECT ${reason}: ${detail.split('\n')[0].slice(0, 120)}`);
    return result;
  };

  if (!env.ok) return reject('env_build_failed', env.reason ?? 'env build failed');
  try {
    // --- trees and patches
    let ts = Date.now();
    progress('Reverting the fix');
    rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    let trees = await headTrees(cand, env, dir);
    if ('failure' in trees) {
      result.head_revert_failure = trees.failure.slice(0, 1000);
      log('check', `${profile.slug}@${cand.sha.slice(0, 8)} HEAD revert failed, using the fix's parent: ${trees.failure.split('\n')[0].slice(0, 120)}`);
      progress('Using the commit before the fix');
      for (const d of ['buggy', 'agent', '.merge']) rmSync(join(dir, d), { recursive: true, force: true });
      trees = await parentTrees(cand, dir);
    }
    const { fixed, buggy, agent } = trees;
    result.buggy_base = trees.base;
    result.fixed_ref = trees.fixedRef;
    result.revert_method = trees.method;
    // Patches relative to the states we actually built (identical to the commit's diff on the fast path).
    writeFileSync(join(dir, 'fix.patch'), await diffTrees(buggy, fixed, cand.source_files, join(dir, '.diff')));
    writeFileSync(join(dir, 'hidden_tests.patch'), await diffTrees(agent, fixed, cand.test_files, join(dir, '.diff')));
    result.hidden_test_files = cand.test_files.filter((f) => fileExists(join(fixed, f)));
    result.deleted_test_files = cand.test_files.filter((f) => !fileExists(join(fixed, f)) && fileExists(join(agent, f)));
    timings.prepare_seconds = secs(Date.now() - ts);

    // --- fail-to-pass on the fix's own test modules
    // Targets must exist in the fixed tree and be part of what the verifier may run (not under an --ignore).
    const ignored = profile.suiteArgs.filter((a) => a.startsWith('--ignore=')).map((a) => a.slice('--ignore='.length));
    const targets = cand.test_files.filter((f) => isTestModule(f) && fileExists(join(fixed, f)) && !ignored.some((p) => f === p || f.startsWith(`${p}/`)));
    result.test_targets = targets;
    if (targets.length === 0) return reject('no_test_targets', 'fix touches no test module that exists in the fixed tree and is in the verifier suite');

    ts = Date.now();
    progress('Testing before and after the fix');
    const buggyRuns: PytestRun[] = [];
    const fixedRuns: PytestRun[] = [];
    const runTargets = (tree: string, tb: 'short' | 'line' = 'line') => runPytest({ image: env.tag, treeDir: tree, args: targets, timeoutMs: opts.targetTimeoutMs, tb });
    const [firstBuggy, firstFixed] = await Promise.all([runTargets(buggy, 'short'), runTargets(fixed)]);
    buggyRuns.push(firstBuggy);
    fixedRuns.push(firstFixed);
    if (firstBuggy.timedOut || firstFixed.timedOut) return reject('timeout', 'targeted test run timed out');

    if (firstBuggy.outcomes.size === 0 && firstBuggy.collectionErrors.length === 0) {
      // pytest never started (conftest import error, usage error): every test would look "missing".
      return reject('import_error_only', `pytest could not start on the buggy state (exit ${firstBuggy.exitCode})\n${firstBuggy.tail}`);
    }
    const passingFixed = [...firstFixed.outcomes].filter(([, o]) => o === 'passed').map(([id]) => id);
    if (passingFixed.length === 0 && trees.base === 'parent' && firstFixed.collectionErrors.length > 0) {
      return reject('env_drift', `the fix's own tree does not collect on the env built at HEAD (dependencies changed since): ${firstFixed.collectionErrors.join(', ')}\n${firstFixed.tail}`);
    }
    if (passingFixed.length === 0) {
      return reject('no_fail_to_pass', `no target test passes on the fixed state (collection errors: ${firstFixed.collectionErrors.join(', ') || 'none'})\n${firstFixed.tail}`);
    }
    let f2p = passingFixed.filter((id) => FAILING.has(outcomeIn(firstBuggy, id)));
    if (f2p.length === 0) return reject('no_fail_to_pass', `all ${passingFixed.length} passing target tests also pass on the buggy state`);

    progress(`${f2p.length} failing; re-running for flakes`);
    for (let i = 1; i < F2P_REPEATS; i++) {
      const [b, f] = await Promise.all([runTargets(buggy), runTargets(fixed)]);
      buggyRuns.push(b);
      fixedRuns.push(f);
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
    result.failing_output = failingOutputFor(firstBuggy, result.fail_to_pass);

    // --- pass-to-pass on a time-boxed subset: the targets plus related modules present in both trees
    ts = Date.now();
    const inBuggy = new Set(listTestModules(buggy, profile));
    const subset = selectSubset({
      modules: listTestModules(fixed, profile).filter((m) => inBuggy.has(m)),
      targets,
      sourceFiles: cand.source_files,
      ignored,
      seed: cand.sha,
      extra: opts.extraModules ?? P2P_EXTRA_MODULES,
    });
    result.suite_modules = subset;
    progress(`Checking ${subset.length} module${subset.length === 1 ? '' : 's'} still pass`);
    const runSubset = (tree: string, deselect: string[] = []) => runPytest({
      image: env.tag,
      treeDir: tree,
      args: [...subset, ...deselect.flatMap((id) => ['--deselect', id])],
      timeoutMs: opts.subsetTimeoutMs,
    });
    const fixedSubset: PytestRun[] = [];
    for (let i = 0; i < P2P_FIXED_REPEATS; i++) fixedSubset.push(await runSubset(fixed, fixedSubset.flatMap((r) => r.crashed)));
    const deselect = [...new Set(fixedSubset.flatMap((r) => r.crashed))];
    const buggySubset = await runSubset(buggy, deselect);
    timings.pass_to_pass_seconds = secs(Date.now() - ts);
    result.subset_seconds = Math.max(...fixedSubset.map((r) => secs(r.ms)));
    const buggySummary = summarizeRun(buggySubset);
    result.buggy_suite = { seconds: buggySummary.seconds, passed: buggySummary.passed, failed: buggySummary.failed, timed_out: buggySummary.timed_out };
    if (buggySubset.timedOut || fixedSubset.some((r) => r.timedOut)) return reject('timeout', `the pass-to-pass subset exceeded ${secs(opts.subsetTimeoutMs)}s`);
    result.deselect = deselect;
    let stable = passingIn(fixedSubset[0]);
    for (const r of fixedSubset.slice(1)) {
      const next = passingIn(r);
      stable = new Set([...stable].filter((id) => next.has(id)));
    }
    const f2pSet = new Set(f2p);
    // Fail-to-pass must also hold in the subset runs, or the verifier would grade it differently.
    const lostF2p = f2p.filter((id) => !stable.has(id));
    if (lostF2p.length > 0) return reject('flaky', `fail-to-pass tests did not pass in the fixed subset run: ${lostF2p.slice(0, 5).join(', ')}`);
    result.pass_to_pass = [...passingIn(buggySubset)].filter((id) => stable.has(id) && !f2pSet.has(id)).sort();

    result.accepted = true;
    timings.total_seconds = secs(Date.now() - t0);
    save();
    log('check', `${profile.slug}@${cand.sha.slice(0, 8)} OK base=${trees.base} f2p=${f2p.length} p2p=${result.pass_to_pass.length} modules=${subset.length} (${timings.total_seconds}s)`);
    return result;
  } catch (e) {
    return reject('check_error', String(e));
  } finally {
    // The buggy tree is only needed for checks; agent (and a parent-base fixed tree) stay for packaging.
    rmSync(join(dir, 'buggy'), { recursive: true, force: true });
    if (!result.accepted) {
      rmSync(join(dir, 'agent'), { recursive: true, force: true });
      rmSync(join(dir, 'fixed'), { recursive: true, force: true });
    }
  }
}

/** The tree holding the fixed versions of the hidden tests, for packaging. */
export function fixedTreeOf(check: CheckResult): string {
  return check.buggy_base === 'parent' ? join(check.workdir, 'fixed') : headTreeDir(profileFor(check.repo).slug);
}
