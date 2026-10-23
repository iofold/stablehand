import { diffConfigs } from './diff.js';
import { describeFailures } from './grader.js';
import type { CampaignResult, Decision, IterationRecord, Receipt, TaskResult } from './types.js';

export const usd = (value: number): string => `$${value.toFixed(value < 1 ? 4 : 2)}`;
const fixed = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(3));
const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
const tokens = (value: number): string => value.toLocaleString('en-US');

const DECISION_LABEL: Record<Decision, string> = {
  baseline: 'baseline',
  keep: 'kept',
  discard: 'discarded',
  invalid: 'invalid proposal',
  stopped: 'stopped',
};

export function decisionLabel(decision: Decision): string {
  return DECISION_LABEL[decision];
}

function receiptTable(receipt: Receipt): string[] {
  return [
    '| Runs | Input tokens | Output tokens | Cost |',
    '|---:|---:|---:|---:|',
    `| ${receipt.runs} | ${tokens(receipt.inputTokens)} | ${tokens(receipt.outputTokens)} | ${usd(receipt.costUsd)}${receipt.costComplete ? '' : ' (some calls not priced yet)'} |`,
  ];
}

function cellText(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function resultRows(results: readonly TaskResult[]): string[] {
  return [
    '| Task | Run | Score | Cost | Turn | Grader |',
    '|---|---:|---:|---:|---|---|',
    ...results.map((result) => {
      const notes = result.score >= 1 ? 'all checks pass' : describeFailures(result.grade).slice(0, 4).join('; ');
      return `| ${result.taskId} | ${result.repeat + 1} | ${result.score.toFixed(2)} | ${usd(result.usage.costUsd)} | ${result.turnId ?? '(none)'} | ${cellText(notes)} |`;
    }),
  ];
}

/** The per-iteration artifact: what changed, what it cost, how each task went. */
export function iterationMarkdown(record: IterationRecord, agentName: string): string {
  const lines = [
    `# Iteration ${record.iteration}: ${decisionLabel(record.decision)}`,
    '',
    `Campaign \`${record.campaignId}\` on agent \`${agentName}\`, finished ${record.finishedAt}.`,
    '',
    `Score ${fixed(record.score)}; best so far ${fixed(record.bestScore)}.`,
    `Decision: ${record.reason}.`,
    `Change: ${record.summary}`,
    '',
    '## Receipt',
    '',
    ...receiptTable(record.receipt),
    '',
    `Campaign spend after this iteration: ${usd(record.spentUsd)}.`,
  ];
  if (record.proposerTurnId) lines.push(`Proposer turn: \`${record.proposerTurnId}\`.`);
  if (record.diff) lines.push('', '## Diff against the best configuration before this iteration', '', '```diff', record.diff, '```');
  if (record.decision === 'baseline') {
    lines.push('', '## Configuration', '', '```text', `model: ${record.config.model}`, '', record.config.instructions, '```');
  }
  if (record.results.length > 0) lines.push('', '## Results', '', ...resultRows(record.results));
  return `${lines.join('\n')}\n`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chartSvg(iterations: readonly IterationRecord[]): string {
  const width = 720;
  const height = 300;
  const left = 48;
  const right = 20;
  const top = 16;
  const bottom = 40;
  const count = Math.max(iterations.length, 2);
  const x = (index: number): number => left + (index * (width - left - right)) / (count - 1);
  const y = (score: number): number => top + (1 - score) * (height - top - bottom);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((tick) => (
    `<line x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}" class="grid"/>`
    + `<text x="${left - 8}" y="${y(tick) + 4}" class="axis" text-anchor="end">${tick.toFixed(2)}</text>`
  ));
  const best = iterations.map((record, index) => `${index === 0 ? 'M' : 'H'}${x(index)}${index === 0 ? ` ${y(record.bestScore)}` : ` V${y(record.bestScore)}`}`);
  const marks = iterations.map((record, index) => {
    const label = `${escapeHtml(`Iteration ${record.iteration}: ${decisionLabel(record.decision)}, score ${fixed(record.score)}. ${record.summary}`)}`;
    const cx = x(index);
    const axisLabel = `<text x="${cx}" y="${height - bottom + 18}" class="axis" text-anchor="middle">${record.iteration}</text>`;
    if (record.score === null || record.decision === 'invalid' || record.decision === 'stopped') {
      const cy = y(0);
      return `${axisLabel}<g class="mark-invalid"><title>${label}</title><path d="M${cx - 5} ${cy - 5} L${cx + 5} ${cy + 5} M${cx + 5} ${cy - 5} L${cx - 5} ${cy + 5}"/></g>`;
    }
    const cy = y(record.score);
    if (record.decision === 'baseline') {
      return `${axisLabel}<g class="mark-baseline"><title>${label}</title><rect x="${cx - 6}" y="${cy - 6}" width="12" height="12"/></g>`;
    }
    return `${axisLabel}<g class="mark-${record.decision}"><title>${label}</title><circle cx="${cx}" cy="${cy}" r="6"/></g>`;
  });
  return [
    `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Slice score per iteration">`,
    ...grid,
    `<path d="${best.join(' ')}" class="best"/>`,
    ...marks,
    `<text x="${(left + width - right) / 2}" y="${height - 4}" class="axis" text-anchor="middle">iteration</text>`,
    '</svg>',
  ].join('');
}

const STOP_TEXT: Record<CampaignResult['stopReason'], string> = {
  'iteration-cap': 'reached the iteration cap',
  budget: 'the next iteration would have crossed the campaign budget',
  'budget-blocked': 'the tag budget refused to start more runs',
  solved: 'the best configuration answered every slice task fully',
  'proposer-failing': 'the proposer failed to produce a valid change twice in a row',
};

export function stopText(reason: CampaignResult['stopReason']): string {
  return STOP_TEXT[reason];
}

/** A self-contained results page: score per iteration with keep/discard marks. */
export function resultsPage(result: CampaignResult): string {
  const rows = result.iterations.map((record) => `<tr class="row-${record.decision}">`
    + `<td>${record.iteration}</td><td>${decisionLabel(record.decision)}</td><td>${fixed(record.score)}</td><td>${fixed(record.bestScore)}</td>`
    + `<td>${record.comparison ? signed(record.comparison.meanGain) : ''}</td><td>${usd(record.receipt.costUsd)}</td>`
    + `<td>${escapeHtml(record.summary)}</td></tr>`).join('');
  const holdout = result.holdout
    ? `On ${result.holdout.taskIds.length} held-out tasks the proposer never saw: baseline ${fixed(result.holdout.baselineScore)}, winner ${fixed(result.holdout.winnerScore)} (${usd(result.holdout.receipt.costUsd)}).`
    : `Held-out check: ${escapeHtml(result.holdoutNote ?? 'not run')}.`;
  const diff = result.winnerIteration > 0 ? diffConfigs(result.baseline, result.winner) : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Experiment loop results</title>
<style>
:root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --keep: #1a7f37; --discard: #cf222e; --base: #0969da; --best: #8250df; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --keep: #3fb950; --discard: #f85149; --base: #4493f8; --best: #ab7df8; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
p { margin: 6px 0; }
.muted { color: var(--muted); }
svg { width: 100%; height: auto; margin: 16px 0 4px; }
.grid { stroke: var(--line); stroke-width: 1; }
.axis { fill: var(--muted); font-size: 12px; }
.best { fill: none; stroke: var(--best); stroke-width: 2; stroke-dasharray: 5 4; }
.mark-keep circle { fill: var(--keep); }
.mark-discard circle { fill: var(--bg); stroke: var(--discard); stroke-width: 2.5; }
.mark-baseline rect { fill: var(--base); }
.mark-invalid path { stroke: var(--muted); stroke-width: 2.5; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: var(--muted); }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: middle; }
.l-base::before { background: var(--base); }
.l-keep::before { background: var(--keep); border-radius: 50%; }
.l-discard::before { border: 2px solid var(--discard); border-radius: 50%; width: 7px !important; height: 7px !important; }
.l-best::before { border-top: 2px dashed var(--best); height: 0 !important; width: 16px !important; }
.table-wrap { overflow-x: auto; margin-top: 20px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.row-keep td:nth-child(2) { color: var(--keep); font-weight: 600; }
.row-discard td:nth-child(2) { color: var(--discard); }
pre { background: color-mix(in srgb, var(--line) 30%, transparent); padding: 12px; overflow-x: auto; font-size: 12.5px; border-radius: 6px; }
</style>
</head>
<body>
<main>
<h1>Experiment loop: ${escapeHtml(result.agentName)}</h1>
<p class="muted">Campaign ${escapeHtml(result.campaignId)}. ${result.sliceTaskIds.length}-task slice: ${escapeHtml(result.sliceTaskIds.join(', '))}.</p>
<p>Baseline ${fixed(result.baselineScore)}, best ${fixed(result.winnerScore)}${result.winnerIteration > 0 ? ` (iteration ${result.winnerIteration})` : ''}. Keep margin ${result.margin.toFixed(3)} per task. ${holdout}</p>
<p>Spent ${usd(result.spentUsd)} of a ${usd(result.budgetUsd)} campaign budget. Stopped because ${stopText(result.stopReason)}.</p>
${chartSvg(result.iterations)}
<div class="legend"><span class="l-base">baseline</span><span class="l-keep">kept</span><span class="l-discard">discarded</span><span class="l-best">best so far</span></div>
<div class="table-wrap"><table>
<thead><tr><th>#</th><th>Decision</th><th>Score</th><th>Best</th><th>Gain</th><th>Cost</th><th>Change</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
${diff ? `<h2>Baseline to winner</h2><pre>${escapeHtml(diff)}</pre>` : ''}
</main>
</body>
</html>
`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... (${text.length - max} more characters in the results artifact)`;
}

/** What the reviewer agent receives: chart, table and the approval request, all precomputed. */
export function reviewerTask(result: CampaignResult, links: { resultsArtifactId: string | null; productionAgent: string }): string {
  const chart = {
    component: 'LineChart',
    props: {
      title: 'Slice score per iteration',
      data: result.iterations
        .filter((record) => record.score !== null && record.decision !== 'stopped')
        .map((record) => ({
          iteration: `${record.iteration} ${decisionLabel(record.decision)}`,
          score: Number((record.score ?? 0).toFixed(3)),
          best: Number(record.bestScore.toFixed(3)),
        })),
      xKey: 'iteration',
      yKey: ['score', 'best'],
    },
  };
  const table = {
    component: 'TableView',
    props: {
      title: 'Iterations',
      columns: [
        { key: 'iteration', label: '#' },
        { key: 'decision', label: 'Decision' },
        { key: 'score', label: 'Score' },
        { key: 'gain', label: 'Gain' },
        { key: 'cost', label: 'Cost' },
        { key: 'change', label: 'Change' },
      ],
      data: result.iterations.map((record) => ({
        iteration: record.iteration,
        decision: decisionLabel(record.decision),
        score: fixed(record.score),
        gain: record.comparison ? signed(record.comparison.meanGain) : '',
        cost: usd(record.receipt.costUsd),
        change: record.summary,
      })),
    },
  };
  const kept = result.iterations.filter((record) => record.decision === 'keep').map((record) => `${record.iteration}: ${record.summary}`);
  const approval = {
    reason: `Promote the configuration from iteration ${result.winnerIteration} to ${links.productionAgent}?`,
    details: {
      campaign: result.campaignId,
      slice: `${fixed(result.baselineScore)} -> ${fixed(result.winnerScore)} on ${result.sliceTaskIds.length} tasks`,
      heldOut: result.holdout
        ? `${fixed(result.holdout.baselineScore)} -> ${fixed(result.holdout.winnerScore)} on ${result.holdout.taskIds.length} unseen tasks`
        : result.holdoutNote ?? 'not run',
      keptChanges: kept,
      cost: `${usd(result.spentUsd)} of ${usd(result.budgetUsd)}`,
      diff: clip(diffConfigs(result.baseline, result.winner), 1800),
      ...(links.resultsArtifactId ? { resultsArtifactId: links.resultsArtifactId } : {}),
    },
  };
  return [
    `Campaign ${result.campaignId} on ${result.agentName} is finished. Show the owner the results, then ask whether to promote the winning configuration to ${links.productionAgent}.`,
    '',
    'Step 1. Call a2ui-render with exactly this input:',
    JSON.stringify(chart),
    '',
    'Step 2. Call a2ui-render with exactly this input:',
    JSON.stringify(table),
    '',
    'Step 3. Call request-approval with exactly this input:',
    JSON.stringify(approval),
    '',
    'Step 4. Reply with one line: Approved or Rejected.',
  ].join('\n');
}
