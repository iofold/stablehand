// Step 4: write a Harbor 0.24 task (plus a SWE-bench-style row) from an accepted check.
//
// <task>/
//   instruction.md            canary comment + issue-style text from the Writer (or a placeholder)
//   task.toml                 [metadata.bugfarm] provenance, separate verifier, no network
//   environment/Dockerfile    FROM the env image, buggy tree at /app, no .git
//   environment/docker-compose.yaml   forces network_mode: none (Harbor's no-network leaks DNS/ICMP)
//   environment/bugfarm-repo/ the agent-visible buggy tree (fix source + fix tests reverted)
//   tests/test.sh             hidden tests overlay -> pytest -> grade.py -> /logs/verifier/reward.txt
//   tests/grade.py, tests/expected.json, tests/hidden/, tests/deleted_tests.txt
//   solution/solve.sh         applies solution/fix.patch (executable)
import { chmodSync, cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PIPELINE_DIR, PIPELINE_VERSION, TASKS_DIR } from './config.ts';
import { fixedTreeOf } from './check-candidate.ts';
import type { CheckResult } from './check-candidate.ts';
import { commitMessage, cloneDir } from './git.ts';
import { PYTEST_FLAGS } from './pytest.ts';
import { profileFor } from './repos.ts';
import type { Candidate } from './scout.ts';
import { ensureDir, writeJson, writeText } from './util.ts';

export interface PackagedTask {
  name: string; // Harbor [task].name, org/name
  dirName: string;
  dir: string;
  repo: string;
  sha: string;
  fail_to_pass: number;
  pass_to_pass: number;
  swebench: Record<string, unknown>;
}

const q = (s: string) => JSON.stringify(s); // JSON string escapes are valid TOML basic-string escapes
const qArr = (a: string[]) => (a.length === 0 ? '[]' : `[\n${a.map((x) => `  ${q(x)},`).join('\n')}\n]`);
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Commit subject/body -> placeholder issue text. Drops PR numbers, emoji prefixes and trailers. Never includes the diff. */
export function placeholderInstruction(repo: string, message: string, sourceDirs: string[]): string {
  const lines = message.replace(/\r/g, '').split('\n');
  const subject = (lines[0] ?? '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/^[^\p{L}\p{N}`'"]+/u, '')
    .trim();
  const body = lines
    .slice(1)
    .filter((l) => !/^\s*(co-authored-by|signed-off-by|reviewed-by|fixes|closes|resolves)\b/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1500);
  const canary = `<!-- bugfarm-canary GUID ${randomUUID()} -->`;
  return [
    canary,
    `# ${subject.charAt(0).toUpperCase()}${subject.slice(1)}`,
    '',
    `The \`${repo}\` repository is checked out at \`/app\` (no git history, no network).`,
    '',
    body ? `${body}\n` : '',
    `Find and fix this bug in the library source (${sourceDirs.map((d) => `\`${d}/\``).join(', ')}).`,
    'Hidden tests exercise the fix, and the existing test suite must keep passing.',
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function testSh(suiteArgs: string[], timeoutSec: number): string {
  const pytest = ['python', '-m', 'pytest', ...PYTEST_FLAGS, '--tb=short', ...suiteArgs].map(shQuote).join(' ');
  return `#!/bin/bash
# Bugfarm verifier. Runs in a separate, fresh copy of the task image after Harbor has copied the
# agent's source dirs (task.toml \`artifacts\`) over /app, so nothing else the agent did can reach it.
set -uo pipefail
mkdir -p /logs/verifier
echo 0 > /logs/verifier/reward.txt
cd /app || exit 0
# Restore the hidden tests: the HEAD versions of the test files the fix touched.
if [ -d /tests/hidden ]; then cp -a /tests/hidden/. /app/; fi
if [ -s /tests/deleted_tests.txt ]; then
  while IFS= read -r f; do [ -n "$f" ] && rm -rf -- "/app/$f"; done < /tests/deleted_tests.txt
fi
export PYTHONDONTWRITEBYTECODE=1
timeout ${timeoutSec} ${pytest} > /logs/verifier/pytest.log 2>&1
python /tests/grade.py /logs/verifier/pytest.log /tests/expected.json /logs/verifier/report.json > /logs/verifier/reward.next \\
  && mv /logs/verifier/reward.next /logs/verifier/reward.txt
cat /logs/verifier/report.json 2>/dev/null || true
`;
}

const SOLVE_SH = `#!/bin/bash
# Reference solution: the fix commit's source diff.
set -euo pipefail
cd /app
git apply --whitespace=nowarn --verbose /solution/fix.patch
`;

export interface PackageOptions {
  /** Issue-style instruction from the Writer. Without it, the commit message becomes a placeholder. */
  instruction?: string;
  /** Provenance for `[metadata.bugfarm]`: the pull request and the issue it closed. */
  pr?: number | null;
  issue?: number | null;
  url?: string | null;
  /** Where the dataset lives; default TASKS_DIR. */
  tasksDir?: string;
}

/** Verifier time-box: a generous multiple of the slowest subset run, at least five minutes. */
export function verifierTimeoutSec(check: Pick<CheckResult, 'subset_seconds' | 'buggy_suite'>): number {
  const seconds = Math.max(check.subset_seconds ?? 0, check.buggy_suite?.seconds ?? 0);
  return Math.max(300, Math.ceil(seconds * 6 + 120));
}

export async function packageTask(check: CheckResult, cand: Candidate, opts: PackageOptions = {}): Promise<PackagedTask> {
  if (!check.accepted) throw new Error(`refusing to package rejected candidate ${check.sha}`);
  if (check.suite_modules.length === 0) throw new Error(`check for ${check.sha} has no verifier modules; re-run check_candidate`);
  const profile = profileFor(check.repo);
  const dirName = `${profile.slug}-${check.sha.slice(0, 10)}`;
  const name = `bugfarm/${dirName}`;
  const dir = join(opts.tasksDir ?? TASKS_DIR, profile.slug, dirName);
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);

  const verifierTimeout = verifierTimeoutSec(check);
  const message = await commitMessage(cloneDir(check.repo), check.sha);
  const suiteArgs = [...check.suite_modules, ...check.deselect.flatMap((id) => ['--deselect', id])];

  // environment/
  // Dereferenced: a task must be self-contained, and Harbor refuses a task whose files link
  // outside it (trees checked before the verbatim-symlink fix hold absolute links).
  cpSync(join(check.workdir, 'agent'), join(dir, 'environment', 'bugfarm-repo'), {
    recursive: true,
    dereference: true,
    // A link to nothing (its target is not in the tree) cannot be dereferenced; leave it out.
    filter: (src) => existsSync(src),
  });
  writeText(join(dir, 'environment', 'Dockerfile'), [
    `FROM ${check.env_image}`,
    'LABEL bugfarm=1',
    '# The env image was built at HEAD; replace its tree with the buggy one and drop any VCS metadata.',
    'RUN rm -rf /app',
    'COPY bugfarm-repo/ /app/', // unique step name so pruneOwnBuildCache can find its cache records
    'RUN rm -rf /app/.git && mkdir -p /logs/verifier /logs/agent /logs/artifacts',
    'WORKDIR /app',
    '',
  ].join('\n'));
  writeText(join(dir, 'environment', 'docker-compose.yaml'), [
    '# Harbor\'s no-network mode filters egress with a sidecar but still resolves DNS; force no interfaces.',
    'services:',
    '  main:',
    '    network_mode: none',
    '    labels:',
    '      bugfarm: "1"',
    '',
  ].join('\n'));

  // tests/
  for (const f of check.hidden_test_files) {
    cpSync(join(fixedTreeOf(check), f), join(dir, 'tests', 'hidden', f));
  }
  writeText(join(dir, 'tests', 'deleted_tests.txt'), check.deleted_test_files.map((f) => `${f}\n`).join(''));
  writeJson(join(dir, 'tests', 'expected.json'), { fail_to_pass: check.fail_to_pass, pass_to_pass: check.pass_to_pass });
  writeText(join(dir, 'tests', 'grade.py'), readFileSync(join(PIPELINE_DIR, 'templates', 'grade.py'), 'utf8'));
  writeText(join(dir, 'tests', 'test.sh'), testSh(suiteArgs, verifierTimeout - 60));
  chmodSync(join(dir, 'tests', 'test.sh'), 0o755);

  // solution/
  // buggy -> HEAD over the source files: the commit's diff, re-based when the 3-way revert was needed.
  const fixPatch = readFileSync(join(check.workdir, 'fix.patch'), 'utf8');
  writeText(join(dir, 'solution', 'fix.patch'), fixPatch);
  writeText(join(dir, 'solution', 'solve.sh'), SOLVE_SH);
  chmodSync(join(dir, 'solution', 'solve.sh'), 0o755);

  // instruction.md
  const instruction = opts.instruction
    ? `<!-- bugfarm-canary GUID ${randomUUID()} -->\n${opts.instruction.trim()}\n`
    : placeholderInstruction(check.repo, message, profile.sourceDirs);
  writeText(join(dir, 'instruction.md'), instruction);

  // task.toml (root keys must precede tables)
  const toml = [
    'schema_version = "1.4"',
    `# The verifier only sees these dirs from the agent's container (separate verifier mode).`,
    `artifacts = [${profile.sourceDirs.map((d) => q(`/app/${d}`)).join(', ')}]`,
    '',
    '[task]',
    `name = ${q(name)}`,
    `description = ${q(`Fix a real bug in ${check.repo} (from ${check.sha.slice(0, 12)})`)}`,
    `keywords = ["bugfarm", "bugfix", "python", ${q(profile.slug)}]`,
    '',
    '[metadata]',
    'category = "bugfix"',
    `instruction_status = ${q(opts.instruction ? 'writer' : 'placeholder')}`,
    '',
    '[metadata.bugfarm]',
    `pipeline_version = ${q(PIPELINE_VERSION)}`,
    `repo = ${q(check.repo)}`,
    `fix_sha = ${q(check.sha)}`,
    `fix_parent = ${q(cand.parent)}`,
    `fix_date = ${q(cand.date)}`,
    `fix_subject = ${q(cand.subject)}`,
    ...(opts.pr ? [`pr = ${opts.pr}`] : []),
    ...(opts.issue ? [`issue = ${opts.issue}`] : []),
    ...(opts.url ? [`url = ${q(opts.url)}`] : []),
    `env_head = ${q(check.head)}`,
    `buggy_from = ${q(check.buggy_base ?? 'head')}`,
    `buggy_base = ${q(check.buggy_base === 'parent' ? cand.parent : check.head)}`,
    check.buggy_base === 'parent'
      ? 'buggy_recipe = "the fix\'s parent tree, run on the env built at env_head; the fixed state is the fix commit"'
      : 'buggy_recipe = "buggy_base with the fix source diff reverted; the agent view also has the fix test diff reverted"',
    `revert_method = ${q(check.revert_method ? `source:${check.revert_method.source},tests:${check.revert_method.tests}` : 'unknown')}`,
    `env_image = ${q(check.env_image)}`,
    `source_files = ${qArr(cand.source_files)}`,
    `test_files = ${qArr(cand.test_files)}`,
    `non_test_lines = ${cand.non_test_lines}`,
    `fail_to_pass = ${qArr(check.fail_to_pass)}`,
    `pass_to_pass_count = ${check.pass_to_pass.length}`,
    'pass_to_pass_scope = "subset: the fix\'s test modules plus related modules"',
    `verifier_modules = ${qArr(check.suite_modules)}`,
    `pass_to_pass = ${qArr(check.pass_to_pass)}`,
    `packaged_at = ${q(new Date().toISOString())}`,
    '',
    '[verifier]',
    `timeout_sec = ${verifierTimeout}.0`,
    'environment_mode = "separate"',
    '',
    '[agent]',
    'timeout_sec = 1800.0',
    '',
    '[environment]',
    'build_timeout_sec = 900.0',
    'cpus = 2',
    'memory_mb = 4096',
    'network_mode = "no-network"',
    '',
  ].join('\n');
  writeText(join(dir, 'task.toml'), toml);

  const testPatch = readFileSync(join(check.workdir, 'hidden_tests.patch'), 'utf8');
  const swebench: Record<string, unknown> = {
    instance_id: `${check.repo.replace('/', '__')}-${check.sha.slice(0, 12)}`,
    repo: check.repo,
    base_commit: check.buggy_base === 'parent' ? check.sha : check.head,
    fix_commit: check.sha,
    created_at: cand.date,
    problem_statement: instruction.replace(/^<!--.*?-->\n/, ''),
    hints_text: '',
    patch: fixPatch,
    test_patch: testPatch,
    FAIL_TO_PASS: check.fail_to_pass,
    PASS_TO_PASS: check.pass_to_pass,
    image_name: check.env_image,
    environment_setup_commit: check.head,
    // Unlike SWE-bench, the buggy state is not always a commit: it is base_commit minus `patch` (and
    // minus `test_patch` for what the solver sees). Apply `test_patch` then `patch` to reach base_commit.
    buggy_state: check.buggy_base === 'parent' ? 'the parent of fix_commit' : 'base_commit with patch and test_patch reverse-applied',
    test_modules: check.suite_modules,
    harbor_task: name,
  };
  return { name, dirName, dir, repo: check.repo, sha: check.sha, fail_to_pass: check.fail_to_pass.length, pass_to_pass: check.pass_to_pass.length, swebench };
}
