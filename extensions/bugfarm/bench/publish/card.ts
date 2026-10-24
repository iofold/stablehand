// The dataset card (README.md on the Hub): what the tasks are, where each came from, how they
// were checked and measured, what they cost, who approved publishing them, and whose code they hold.
import type { Approval } from './approval.ts';
import type { DatasetModel, LeaderboardCell } from './dataset.ts';

const FAMILY_LABEL: Record<string, string> = { anthropic: 'Claude', openai: 'GPT', google: 'Gemini', open: 'Open weights' };

function usd(v: number | null | undefined, places = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : `$${v.toFixed(places)}`;
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`;
}

function cellText(v: unknown): string {
  return String(v ?? '–').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function table(head: string[], rows: unknown[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cellText).join(' | ')} |`)].join('\n');
}

function slugTitle(m: DatasetModel): string {
  const repo = m.def.repo.split('/').pop() ?? m.def.repo;
  return m.def.task_set.kind === 'dev_standin' ? `Bugfarm ${repo} (development stand-in)` : `Bugfarm ${repo}`;
}

function who(a: Approval): string {
  const r = a.resolved_by;
  if (!r) return 'Stablehand (no person recorded)';
  if (r.type === 'api_key') return `the holder of access key \`${r.keyName ?? r.keyId ?? 'unknown'}\`${r.keyId ? ` (${r.keyId})` : ''}`;
  if (r.type === 'master_token') return 'the operator, with the deployment\'s master token';
  return r.type;
}

function leaderboard(cells: LeaderboardCell[]): string {
  return table(
    ['#', 'Model', 'Agent', 'pass@1', '95% interval', 'Solved', '$ per solve', 'Median agent time'],
    cells.map((c, i) => [
      c.attempts ? i + 1 : '–',
      c.model,
      c.runner,
      pct(c.pass_at_1),
      c.ci_low === null ? '–' : `${pct(c.ci_low)} to ${pct(c.ci_high)}`,
      `${c.solved} of ${c.attempts} tries`,
      usd(c.usd_per_solve),
      c.median_seconds === null ? '–' : `${Math.round(c.median_seconds)} s`,
    ]),
  );
}

export function renderCard(m: DatasetModel, approval: Approval | null): string {
  const { def, ledger } = m;
  const repo = def.repo;
  const standin = def.task_set.kind === 'dev_standin';
  const families = [...new Set(m.tasks.flatMap((t) => Object.keys(t.difficulty)))];
  const rec = ledger.reconciliation;
  const out: string[] = [];

  out.push('---');
  out.push('license: other');
  out.push('license_name: upstream-repository-licenses');
  out.push('license_link: README.md#license');
  out.push(`pretty_name: ${JSON.stringify(slugTitle(m))}`);
  out.push('language:\n- en');
  out.push('tags:\n- code\n- software-engineering\n- bug-fixing\n- swe-bench\n- harbor\n- rl-environments\n- bugfarm');
  out.push('size_categories:\n- n<1K');
  out.push('configs:\n- config_name: swebench\n  data_files:\n  - split: test\n    path: data/swebench.jsonl');
  out.push('---');
  out.push('');
  out.push(`# ${slugTitle(m)}`);
  out.push('');
  if (standin) {
    out.push(`> **Development stand-in, not a release.** ${def.task_set.label}. ${def.task_set.note ?? ''}`.trim());
    out.push('');
  }
  out.push(
    `${m.tasks.length} coding ${m.tasks.length === 1 ? 'task' : 'tasks'} mined from the git history of [${repo}](https://github.com/${repo}). Each one is a real bug fix turned back into a bug: the repository at the commit before the fix, an issue-style instruction, hidden tests that fail on the bug and pass on the fix, and the fix as the reference solution. The tasks are [Harbor](https://harborframework.com) tasks, so any Harbor agent can run them, and each also comes as one SWE-bench-style row.`,
  );
  out.push('');
  out.push(`They were made by Bugfarm, an agent factory that runs on [Stablehand](https://github.com/iofold/stablehand). Every task carries a receipt: the commit it came from, how it was checked, every model attempt, and what it cost.`);
  out.push('');

  out.push('## At a glance');
  out.push('');
  out.push(table(['', ''], [
    ['Repository', repo],
    ['Tasks', m.tasks.length],
    ['Fixes from', `${m.tasks.map((t) => t.fix_date?.slice(0, 10)).filter(Boolean).sort()[0] ?? '–'} to ${m.tasks.map((t) => t.fix_date?.slice(0, 10)).filter(Boolean).sort().at(-1) ?? '–'}`],
    ['Benchmark', `${def.cells.length} agent and model pairs, ${def.k} tries per task each (run \`${def.id}\`)`],
    ['Spend, calibration and benchmark', usd(ledger.totals.campaign_usd)],
    ['Dataset sha256', `\`${m.sha}\``],
    ['Approved', approval ? `${approval.action === 'approve' ? 'yes' : 'no'}, ${new Date(approval.resolved_at ?? 0).toISOString()}` : 'not yet'],
  ]));
  out.push('');

  out.push('## Contents');
  out.push('');
  out.push('```text');
  out.push('tasks/<task>/              Harbor 0.24 task: instruction.md, task.toml, environment/, tests/, solution/');
  out.push('data/swebench.jsonl        one row per task (instance_id, repo, base_commit, patch, test_patch, FAIL_TO_PASS, PASS_TO_PASS, ...)');
  out.push('leaderboard.json           the benchmark below, per agent and model pair');
  out.push('spend/ledger.json, .csv    cost per task and for the campaign');
  out.push('spend/reconciliation.json the ledger against the gateway spend log and the Stablehand budget');
  out.push('provenance/manifest.json   sha256 of every other file; the dataset sha is the hash of this list');
  out.push('provenance/approval.json   who approved publishing, when, and why');
  out.push('```');
  out.push('');
  out.push(`Run a task with Harbor: \`harbor run -p tasks/${m.tasks[0]?.name ?? '<task>'} -a <agent> -m <model>\`. The task image builds \`FROM\` the repository's environment image (\`${String(m.rows[0]?.image_name ?? 'see task.toml')}\`); its Dockerfile is in the task, and no image is published.`);
  out.push('');

  out.push('## Provenance');
  out.push('');
  out.push(table(['Task', 'Fix commit', 'Fixed on', 'Fix', 'Instruction'], m.tasks.map((t) => [
    `\`${t.name}\``,
    `[${t.sha.slice(0, 12)}](https://github.com/${repo}/commit/${t.sha})`,
    t.fix_date?.slice(0, 10) ?? '–',
    t.title,
    t.instruction_status === 'writer' ? 'written by the Writer agent, leak-checked' : 'placeholder from the commit title',
  ])));
  out.push('');
  out.push(`Pipeline: Bugfarm worker and pipeline (Stablehand \`extensions/bugfarm\`), Harbor ${def.harbor_version}${def.stablehand_harbor_version ? `, stablehand-harbor ${def.stablehand_harbor_version}` : ''}. Benchmark tasks are snapshots taken when run \`${def.id}\` was frozen (tasks sha \`${def.tasks_sha}\`).`);
  out.push('');

  out.push('## How the tasks were made and checked');
  out.push('');
  out.push('1. **Mined.** Merged fixes that change both source and tests, small enough to state as one issue.');
  out.push('2. **Fails, then passes.** The buggy state is the repository with the fix reverted. The fix\'s own tests must fail on it and pass on the fixed state, three runs each; anything that changes between runs is dropped as flaky. Related tests that already passed must keep passing.');
  out.push('3. **Controls.** In Harbor, the reference fix must score 1 and doing nothing must score 0. The task container has no network and no `.git`, and a separate verifier container grades only the source directories.');
  out.push('4. **Calibrated (selection).** Models from several families try each task on a 2, 4, 8, 16 ladder of attempts; a task is kept when someone solves it sometimes and the strongest family solves it at most half the time. These attempts only decide which tasks to keep.');
  out.push('5. **Benchmarked (measurement).** A fresh run on the kept tasks, below. No number from step 4 is reported as a benchmark number.');
  out.push('');

  out.push('## Difficulty by model family');
  out.push('');
  if (families.length) {
    out.push('Calibration results (selection attempts with Harbor\'s terminus-2), one model per family. "2 of 8" means 2 of 8 attempts passed.');
    out.push('');
    out.push(table(['Task', 'Decision', ...families.map((f) => FAMILY_LABEL[f] ?? f)], m.tasks.map((t) => [
      `\`${t.name}\``,
      t.calibration?.decision ?? '–',
      ...families.map((f) => {
        const d = t.difficulty[f];
        return d ? `${d.passes} of ${d.attempts}${d.model ? ` (${d.model})` : ''}` : '–';
      }),
    ])));
  } else {
    out.push('These tasks have no calibration receipts yet.');
  }
  out.push('');

  out.push('## Leaderboard');
  out.push('');
  out.push(`Which agent is best on ${repo}, and what does a solved bug cost? Each pair got ${def.k} tries at each task, in run \`${def.id}\`, which was never used to pick the tasks.`);
  out.push('');
  out.push(leaderboard(m.cells));
  out.push('');
  out.push('pass@1 is the share of tries that passed the hidden tests, averaged over tasks. The 95% interval resamples tasks (10,000 bootstrap draws), so with few tasks it is wide. A try the provider failed (a rate limit, a 5xx) ran again; a try that still errors counts as unsolved. "$ per solve" is the pair\'s whole spend, priced by the model gateway, divided by its passing tries. Median agent time is the agent\'s own time per try.');
  const notes = [...new Set(m.cells.flatMap((c) => c.notes.map((n) => `${c.runner}: ${n}`)))];
  if (notes.length) {
    out.push('');
    for (const n of notes) out.push(`- ${n}`);
  }
  out.push('');
  out.push('"Stablehand" pairs run a Stablehand harness in a sandbox with no internet access. It reaches the task container only through four relay tools (run a command, read a file, write a file, submit), and provider-side web search and fetch are off. "Harbor terminus-2" is Harbor\'s own agent, driving the task container from the host.');
  out.push('');

  out.push('## Spend ledger');
  out.push('');
  out.push(`Every model call went through the deployment's model gateway under one campaign budget, so every dollar below comes from the gateway's own bill.`);
  out.push('');
  out.push(table(['Task', 'Authoring', 'Selection (calibration)', 'Measurement (benchmark)', 'Total'], [
    ...ledger.tasks.map((t) => [`\`${t.task}\``, usd(t.authoring_usd), usd(t.selection_usd), usd(t.measurement_usd), usd(t.total_usd)]),
    ...(ledger.other_selection_usd ? [['Candidates not in this dataset (rejected or undecided)', '–', usd(ledger.other_selection_usd), '–', usd(ledger.other_selection_usd)]] : []),
    ['**Campaign total**', usd(ledger.totals.authoring_usd), usd(ledger.totals.selection_usd), usd(ledger.totals.measurement_usd), `**${usd(ledger.totals.campaign_usd)}**`],
  ]));
  out.push('');
  if (ledger.authoring) out.push(`- Authoring: ${ledger.authoring.note}`);
  if (ledger.selection) {
    const s = ledger.selection;
    out.push(`- Selection: ${usd(s.tasks_usd)} of calibration attempts on these tasks${s.campaign_total_usd !== null ? `; the calibration campaign${s.campaign ? ` \`${s.campaign}\`` : ''} spent ${usd(s.campaign_total_usd, 4)} in all${s.campaign_calls !== null ? ` over ${s.campaign_calls} calls` : ''}` : ''}${s.gateway_usd !== null ? `, and the gateway's spend log shows ${usd(s.gateway_usd, 4)} for its keys` : ''}. The campaign total counts toward the total above.`);
  }
  if (rec) {
    out.push(`- Measurement: ${rec.ledger.attempts} tries${rec.ledger.voided_executions ? ` plus ${rec.ledger.voided_executions} voided ${rec.ledger.voided_executions === 1 ? 'execution' : 'executions'} that ran again after a provider failure or an interrupted run (${usd(rec.ledger.voided_usd, 4)}, counted in the total but not in any pass rate)` : ''} cost ${usd(rec.ledger.total_usd, 4)}${rec.ledger.running ? ` (draft: ${rec.ledger.running} trials were still running, so the gateway and budget views below include spend the ledger does not have yet)` : ''}.`);
    if (rec.gateway.total_usd !== null) out.push(`  - Gateway spend log, read independently: ${usd(rec.gateway.total_usd, 4)}${rec.gateway.campaign_key ? ` (campaign key ${usd(rec.gateway.campaign_key.matched_usd, 4)}` : ''}${rec.gateway.sessions ? `${rec.gateway.campaign_key ? ', ' : ' ('}Stablehand sessions ${usd(rec.gateway.sessions.usd, 4)} over ${rec.gateway.sessions.turns_matched} turns)` : rec.gateway.campaign_key ? ')' : ''}; difference ${usd(rec.differences.ledger_vs_gateway_usd, 6)}.`);
    if (rec.stablehand.budget_policy) out.push(`  - Stablehand campaign budget \`${def.campaign}\`: ${usd(rec.stablehand.budget_policy.spend_usd, 4)} of a ${usd(rec.stablehand.budget_policy.cap_usd)} cap${rec.stablehand.other_tagged_turns?.turns ? `, of which ${usd(rec.stablehand.other_tagged_turns.usd, 4)} is ${rec.stablehand.other_tagged_turns.turns} non-benchmark ${rec.stablehand.other_tagged_turns.turns === 1 ? 'turn' : 'turns'} (publish approvals)` : ''}; difference ${usd(rec.differences.ledger_vs_budget_usd, 6)}.`);
  }
  out.push('');

  out.push('## Approval');
  out.push('');
  if (approval) {
    out.push(`Publishing was ${approval.action === 'approve' ? '**approved**' : '**rejected**'} by ${who(approval)} on ${new Date(approval.resolved_at ?? 0).toISOString()}, through Stablehand's \`request-approval\` (interrupt \`${approval.interrupt_id}\`).`);
    out.push('');
    out.push(`> ${approval.reason ? approval.reason.replace(/\n/g, '\n> ') : '(no reason given)'}`);
    out.push('');
    out.push(`The request named ${approval.request.tasks} tasks, ${usd(approval.request.total_spend_usd)} of spend and this dataset's sha256 \`${approval.request.dataset_sha}\`. \`provenance/approval.json\` has the full record.`);
  } else {
    out.push('Not approved yet. Bugfarm asks a person through Stablehand before anything is published.');
  }
  out.push('');

  out.push('## Credits');
  out.push('');
  out.push('- [Harbor](https://harborframework.com): the task format and the runner every attempt used.');
  out.push('- Repo2RLEnv (Hugging Face), SWE-rebench and SWE-smith: prior work on mining repositories into verifiable environments, which this method follows. The SWE-bench-style rows follow [SWE-bench](https://www.swebench.com).');
  out.push('- Not to be confused with the 2023 BugFarm paper ([arXiv:2310.02407](https://arxiv.org/abs/2310.02407)), which generates bugs; these tasks are real fixes.');
  out.push('');

  out.push('## License');
  out.push('');
  out.push(`The code snapshots (\`tasks/*/environment/bugfarm-repo/\`), the hidden tests and the patches come from [${repo}](https://github.com/${repo}), and **that repository's license applies to them**${m.license.file ? ` (its \`${m.license.file}\` begins: "${m.license.first_line}")` : ''}. Keep its notices when you redistribute them. The files Bugfarm wrote (instructions, \`task.toml\`, the verifier scripts, the JSONL metadata, this card and the ledgers) are released under the MIT license.`);
  out.push('');
  out.push(`Each \`instruction.md\` carries a canary GUID. If you find one in a model's training data, the tasks are contaminated for that model.`);
  out.push('');
  return out.join('\n');
}
