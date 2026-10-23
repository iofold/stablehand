import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixedTreeOf } from '../../pipeline/lib/check-candidate.ts';
import type { CheckResult } from '../../pipeline/lib/check-candidate.ts';
import { readCheck } from '../jobs/pipeline-jobs.js';
import type { LeakCheckInput } from '../leak-check.js';

/** What the Writer and the leak check need to know about one checked candidate. */
export interface ItemContext {
  check: CheckResult;
  /** buggy → fixed over the source files: the reference solution. */
  fixDiff: string;
  /** agent view → fixed over the test files: the hidden tests. */
  testDiff: string;
  /** Full fixed source of the hidden test files. */
  testSource: string;
  sourceFiles: string[];
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`, { cause: err });
  }
}

export function loadItemContext(repo: string, sha: string): ItemContext {
  const check = readCheck(repo, sha);
  const fixed = fixedTreeOf(check);
  const testSource = check.hidden_test_files.map((f) => `# ${f}\n${readText(join(fixed, f))}`).join('\n\n');
  const sourceFiles = [...new Set(readText(join(check.workdir, 'fix.patch')).split('\n')
    .filter((line) => line.startsWith('+++ b/') || line.startsWith('--- a/'))
    .map((line) => line.slice(6)))];
  return {
    check,
    fixDiff: readText(join(check.workdir, 'fix.patch')),
    testDiff: readText(join(check.workdir, 'hidden_tests.patch')),
    testSource,
    sourceFiles,
  };
}

export function leakInputFor(context: ItemContext, instruction: string): LeakCheckInput {
  return {
    instruction,
    fixDiff: context.fixDiff,
    sourceFiles: context.sourceFiles,
    testSource: context.testSource,
    testFiles: context.check.hidden_test_files,
    failToPass: context.check.fail_to_pass,
  };
}

/** `+N −M in K files` for the card, from the fix diff. */
export function diffStats(diff: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { files, additions, deletions };
}
