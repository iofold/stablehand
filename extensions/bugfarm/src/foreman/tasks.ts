import type { EnvContext } from '../../pipeline/lib/build-env.ts';
import type { ItemContext } from './context.js';

/**
 * The task text for each floor agent's turn. The agents' manifests carry the standing
 * instructions; these carry the specifics of one turn. Everything here is rendered from stored
 * data only, so a restarted foreman renders the same text again.
 */

const MAX_TEXT = 4000;

function clip(text: string | null | undefined, max = MAX_TEXT): string {
  const value = (text ?? '').trim();
  return value.length > max ? `${value.slice(0, max)}\n[...truncated...]` : value;
}

function fence(lang: string, body: string): string {
  const ticks = body.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${body.trimEnd()}\n${ticks}`;
}

export interface ScoutTaskInput {
  repo: string;
  since: string;
  want: number;
  batch: number;
  /** PRs earlier batches already used; never return them again. */
  exclude: number[];
  rulesJson: string;
  sourceDirs: string[];
  testDirs: string[];
}

export function scoutTask(input: ScoutTaskInput): string {
  return [
    `Find ${input.want} bug-fix pull requests in ${input.repo} for Bugfarm batch ${input.batch}.`,
    '',
    `- Repository: ${input.repo}`,
    `- Merged on or after: ${input.since}`,
    `- How many to submit: ${input.want} (up to ${input.want + 5} is fine; the best first)`,
    input.exclude.length > 0 ? `- Already used, never submit again: ${input.exclude.map((n) => `#${n}`).join(', ')}` : '- Already used: none',
    '',
    'The playbook (rules.json) for this turn:',
    fence('json', input.rulesJson),
    '',
    'List the units with:',
    fence('bash', `python3 bugfarm/mine_prs.py units --repo ${input.repo} --since ${input.since} --source-dirs ${input.sourceDirs.join(',')} --test-dirs ${input.testDirs.join(',')}`),
    'Then shortlist by title and files, fetch details for the shortlist, apply the playbook, and call submit_candidates once with the ranked list.',
    'A scout_filter with a skip_if predicate is applied by the worker: submit_candidates drops the candidates it matches and says which, so send a few extra, and resubmit the full list with replacements if it drops any.',
  ].join('\n');
}

export interface EnvTaskInput {
  context: EnvContext;
  rulesJson: string;
  /** Logs from a previous failed attempt, when this is a retry. */
  previousFailure?: string | null;
}

export function envTask(input: EnvTaskInput): string {
  const { context } = input;
  const files = Object.entries(context.files).map(([name, text]) => `### ${name}\n${fence('', text)}`).join('\n\n');
  const testDirs = Object.entries(context.test_dirs).map(([dir, entries]) => `- ${dir}/: ${entries.join(', ')}`).join('\n');
  return [
    `Build the test environment image for ${context.repo} at ${context.head.slice(0, 12)}.`,
    '',
    `The build context is the repository tree at that commit, without .git. The checks later run \`python -m pytest ${context.suite_args.join(' ')}\` from /app with the tree copied there, and the package must import from /app (an editable install). Package source lives in: ${context.source_dirs.join(', ')}.`,
    '',
    'Top level of the tree:',
    context.top_level.join('  '),
    '',
    'Test directories:',
    testDirs || '(none found)',
    '',
    'Packaging and test configuration:',
    files || '(none found)',
    '',
    'The playbook (rules.json) for this turn:',
    fence('json', input.rulesJson),
    input.previousFailure ? `\nA previous attempt did not get the suite to collect. Its last log lines:\n${fence('', clip(input.previousFailure, 3000))}` : '',
    '',
    `Call start_job with kind "build_env" and args {"repo": "${context.repo}", "dockerfile": "<the full Dockerfile>"}, then job_status with wait_seconds 240 until it is done. Fix and resubmit until the result says ok: true. Stop after 5 builds.`,
  ].join('\n');
}

export interface WriterTaskInput {
  repo: string;
  item: string;
  pr: number | null;
  title: string;
  prBody: string | null;
  issue: number | null;
  issueTitle: string | null;
  issueBody: string | null;
  context: ItemContext;
  rulesJson: string;
}

function evidence(input: WriterTaskInput): string[] {
  const { context } = input;
  return [
    `Pull request${input.pr ? ` #${input.pr}` : ''}: ${input.title}`,
    input.prBody ? fence('text', clip(input.prBody, 3000)) : '(no description)',
    input.issue ? `\nIt closes issue #${input.issue}: ${input.issueTitle ?? ''}` : '',
    input.issue && input.issueBody ? fence('text', clip(input.issueBody, 3000)) : '',
    '',
    'The fix (for your understanding only; it must never show through):',
    fence('diff', clip(context.fixDiff, 6000)),
    '',
    'The hidden tests that must pass after the fix (the solver never sees them):',
    fence('diff', clip(context.testDiff, 6000)),
    '',
    `Tests that fail before the fix: ${context.check.fail_to_pass.slice(0, 20).join(', ')}`,
    '',
    'How they fail on the buggy code:',
    fence('text', clip(context.check.failing_output ?? '', 3000)),
  ];
}

export function writerTask(input: WriterTaskInput): string {
  return [
    `Write the task instruction for ${input.repo}, card ${input.item}.`,
    '',
    ...evidence(input),
    '',
    'The playbook (rules.json) for this turn:',
    fence('json', input.rulesJson),
    '',
    'Write an issue-style instruction for a developer who sees only the buggy repository at /app. Call submit_instruction with the full text. If it reports leaks, rewrite and submit again. Stop after 3 submissions.',
  ].join('\n');
}

export function reviewTask(input: WriterTaskInput & { draft: string }): string {
  return [
    `Review the task instruction for ${input.repo}, card ${input.item}, before it ships.`,
    '',
    'The draft:',
    fence('markdown', input.draft),
    '',
    ...evidence(input),
    '',
    'The playbook (rules.json) for this turn:',
    fence('json', input.rulesJson),
    '',
    'Check the draft against the fix: does it name a changed file, module, function or class, quote a line of the diff, describe the code change, or hint at where to look? Does it still state the symptom clearly enough to be solvable? Rewrite only what needs it, then call submit_instruction with the final text, even if it is unchanged.',
  ].join('\n');
}
