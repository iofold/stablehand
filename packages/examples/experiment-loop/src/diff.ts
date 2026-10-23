import type { CandidateConfig } from './types.js';

/** A stable text form of a configuration, so diffs read line by line. */
export function renderConfig(config: CandidateConfig): string {
  return [
    `model: ${config.model}`,
    `reasoning: ${config.reasoning ?? '(harness default)'}`,
    `maxTokens: ${config.maxTokens ?? '(harness default)'}`,
    `nativeTools: ${config.nativeTools ?? '(manifest default)'}`,
    'instructions:',
    ...config.instructions.trimEnd().split('\n').map((line) => `  ${line}`),
  ].join('\n');
}

/** Line diff (longest common subsequence) with unchanged runs folded. */
export function diffLines(before: string, after: string, context = 2): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Array<{ kind: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', line: a[i]! }); i += 1; j += 1; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { ops.push({ kind: '-', line: a[i]! }); i += 1; }
    else { ops.push({ kind: '+', line: b[j]! }); j += 1; }
  }
  while (i < a.length) { ops.push({ kind: '-', line: a[i]! }); i += 1; }
  while (j < b.length) { ops.push({ kind: '+', line: b[j]! }); j += 1; }

  if (!ops.some((op) => op.kind !== ' ')) return '';
  const keep = ops.map((op, index) => op.kind !== ' '
    || ops.slice(Math.max(0, index - context), index + context + 1).some((near) => near.kind !== ' '));
  const out: string[] = [];
  let folded = 0;
  ops.forEach((op, index) => {
    if (keep[index]) {
      if (folded > 0) { out.push(`  ... ${folded} unchanged line${folded === 1 ? '' : 's'}`); folded = 0; }
      out.push(`${op.kind} ${op.line}`);
    } else {
      folded += 1;
    }
  });
  if (folded > 0) out.push(`  ... ${folded} unchanged line${folded === 1 ? '' : 's'}`);
  return out.join('\n');
}

export function diffConfigs(before: CandidateConfig, after: CandidateConfig): string {
  return diffLines(renderConfig(before), renderConfig(after));
}
