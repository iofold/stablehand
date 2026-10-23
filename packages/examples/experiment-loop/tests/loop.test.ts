import { describe, expect, it } from 'vitest';

import { decide, measureNoise } from '../src/decide.js';
import { diffConfigs } from '../src/diff.js';
import { runCampaign } from '../src/loop.js';
import { answerKeyValues, parseProposal } from '../src/proposal.js';
import { resultsPage, reviewerTask } from '../src/report.js';
import { BASELINE, type Behaviour, FakeStablehand, fakeTask, proposal, settings } from './fake-harness.js';

/** RULE-A fixes t1 and t2, RULE-B fixes t3, BREAK half-breaks t4 (which the baseline gets right). */
const rules: Behaviour = (config, taskId) => {
  const has = (rule: string): boolean => config.instructions.includes(rule);
  if (taskId === 't1' || taskId === 't2') return has('RULE-A') ? 'pass' : 'fail';
  if (taskId === 't3') return has('RULE-B') ? 'pass' : 'fail';
  if (taskId === 'h1') return has('RULE-A') ? 'pass' : 'fail';
  return has('BREAK') ? 'half' : 'pass';
};

describe('decide', () => {
  it('keeps a gain above the margin that wins more tasks than it loses', () => {
    const best = new Map([['a', 0], ['b', 1], ['c', 0.5]]);
    expect(decide(best, new Map([['a', 1], ['b', 1], ['c', 0.5]]), 0.05)).toMatchObject({
      keep: true,
      comparison: { pairs: 3, wins: 1, losses: 0, ties: 2 },
    });
    expect(decide(best, new Map([['a', 0], ['b', 1], ['c', 0.5]]), 0.05).reason).toContain('within the 0.050 noise margin');
    expect(decide(best, new Map([['a', 1], ['b', 0.5], ['c', 0]]), 0.05)).toMatchObject({ keep: false });
    expect(decide(best, new Map([['a', 0], ['b', 0], ['c', 0.5]]), 0.05).reason).toContain('worse than the best configuration');
  });

  it('measures noise as the average spread of a task across repeats', () => {
    expect(measureNoise([
      { taskId: 'a', score: 1 }, { taskId: 'a', score: 0 },
      { taskId: 'b', score: 1 }, { taskId: 'b', score: 1 },
    ])).toBe(0.5);
  });
});

describe('experiment loop with a fake harness and a fake grader', () => {
  it('keeps changes that help, discards ones that do not, and stops when solved', async () => {
    const fake = new FakeStablehand({
      behaviour: rules,
      proposals: [
        proposal(`${BASELINE.instructions}\nRULE-A: write dates as ISO.`, 'add rule A'),
        proposal(`${BASELINE.instructions}\nRULE-A: write dates as ISO.\nBe concise.`, 'ask for brevity'),
        proposal(`${BASELINE.instructions}\nRULE-A: write dates as ISO.\nRULE-B: codes.\nBREAK`, 'rule B plus a regression'),
        proposal(`${BASELINE.instructions}\nRULE-A: write dates as ISO.\nRULE-B: codes.`, 'add rule B'),
      ],
    });
    const result = await runCampaign(settings({ holdout: [fakeTask('h1')] }), fake);

    expect(result.iterations.map((record) => record.decision)).toEqual(['baseline', 'keep', 'discard', 'discard', 'keep']);
    expect(result.iterations.map((record) => record.score)).toEqual([0.25, 0.75, 0.75, 0.875, 1]);
    expect(result.iterations[3]?.reason).toContain('as many tasks got worse as better');
    expect(result.stopReason).toBe('solved');
    expect(result.winnerIteration).toBe(4);
    expect(result.winner.instructions).toContain('RULE-B');
    expect(result.winner.instructions).not.toContain('BREAK');

    // Every iteration left a record with a receipt; candidates also left a diff.
    expect(fake.records).toHaveLength(5);
    const kept = fake.records[1]!;
    expect(kept.receipt).toMatchObject({ runs: 5, costComplete: true, totalTokens: 600 });
    expect(kept.receipt.costUsd).toBeCloseTo(0.045, 9);
    expect(kept.receipt.turnIds).toHaveLength(5);
    expect(kept.diff).toContain('+   RULE-A: write dates as ISO.');
    expect(result.spentUsd).toBeCloseTo(fake.records.at(-1)!.spentUsd + (result.holdout?.receipt.costUsd ?? 0), 9);

    // The proposer saw the failing tasks with what the grader expected, not the passing one.
    expect(fake.prompts[0]).toContain('### t1 (score 0.00)');
    expect(fake.prompts[0]).toContain('answer: expected "pass", got "fail"');
    expect(fake.prompts[0]).not.toContain('### t4');
    expect(fake.prompts[2]).toContain('iteration 2, discard (+0.000): ask for brevity');

    // Held-out check: baseline and winner on a task the proposer never saw.
    expect(result.holdout).toMatchObject({ taskIds: ['h1'], baselineScore: 0, winnerScore: 1 });
    expect(fake.runs.at(-2)?.context.role).toBe('holdout-baseline');
    expect(fake.runs.at(-1)?.context.role).toBe('holdout-winner');
    expect(fake.applied.at(-1)).toEqual(result.winner);
  });

  it('uses the baseline repeats to keep a lucky flake from counting as a gain', async () => {
    // t4 fails on the first baseline run and passes on every later run, whatever the config.
    const flaky: Behaviour = (config, taskId, context) => (
      taskId === 't4' ? (context.role === 'baseline' && context.repeat === 0 ? 'fail' : 'pass') : rules(config, taskId, context)
    );
    const noChange = proposal(`${BASELINE.instructions}\nBe concise.`, 'ask for brevity');

    const single = await runCampaign(settings({ maxIterations: 1 }), new FakeStablehand({ behaviour: flaky, proposals: [noChange] }));
    expect(single.margin).toBe(0.05);
    expect(single.iterations[1]?.decision).toBe('keep');

    const repeated = await runCampaign(settings({ maxIterations: 1, baselineRepeats: 2 }), new FakeStablehand({ behaviour: flaky, proposals: [noChange] }));
    expect(repeated.margin).toBe(0.25);
    expect(repeated.iterations[0]?.results).toHaveLength(8);
    expect(repeated.iterations[1]?.decision).toBe('discard');
    expect(repeated.iterations[1]?.reason).toContain('within the 0.250 noise margin');
    expect(repeated.winnerIteration).toBe(0);
    expect(repeated.holdoutNote).toBe('no change beat the baseline, so there is nothing to promote');
  });

  it('stops before an iteration would cross the campaign budget', async () => {
    const fake = new FakeStablehand({
      behaviour: rules,
      proposals: [(call) => proposal(`${BASELINE.instructions}\nWording ${call}.`)],
    });
    const result = await runCampaign(settings({ maxIterations: 10, baselineRepeats: 2, budgetUsd: 0.2 }), fake);
    // Baseline $0.08; each iteration $0.045 (4 runs + proposer). After two the projection crosses $0.20.
    expect(result.stopReason).toBe('budget');
    expect(result.iterations).toHaveLength(3);
    expect(result.spentUsd).toBeCloseTo(0.17, 9);
    expect(result.spentUsd).toBeLessThanOrEqual(0.2);
    expect(fake.lines.some((line) => line.includes('stopping: the next iteration would cost about'))).toBe(true);
  });

  it('stops when the tag budget refuses to start runs', async () => {
    const blockedLater: Behaviour = (config, taskId, context) => (context.iteration >= 2 ? 'blocked' : rules(config, taskId, context));
    const fake = new FakeStablehand({
      behaviour: blockedLater,
      proposals: [(call) => proposal(`${BASELINE.instructions}\nRULE-A ${call}.`)],
    });
    const result = await runCampaign(settings(), fake);
    expect(result.stopReason).toBe('budget-blocked');
    expect(result.iterations.map((record) => record.decision)).toEqual(['baseline', 'keep', 'stopped']);
    expect(fake.prompts).toHaveLength(2);
    expect(result.winnerIteration).toBe(1);

    const blockedAtStart = new FakeStablehand({ behaviour: () => 'blocked', proposals: [proposal('never used')] });
    const none = await runCampaign(settings(), blockedAtStart);
    expect(none.stopReason).toBe('budget-blocked');
    expect(none.iterations.map((record) => record.decision)).toEqual(['stopped']);
    expect(blockedAtStart.prompts).toHaveLength(0);
  });

  it('stops at the iteration cap', async () => {
    const fake = new FakeStablehand({
      behaviour: rules,
      proposals: [(call) => proposal(`${BASELINE.instructions}\nWording ${call}.`)],
    });
    const result = await runCampaign(settings({ maxIterations: 2 }), fake);
    expect(result.stopReason).toBe('iteration-cap');
    expect(result.iterations.map((record) => record.decision)).toEqual(['baseline', 'discard', 'discard']);
    expect(fake.applied.at(-1)).toEqual(BASELINE);
  });

  it('records invalid proposals, rejects copied answers, and gives up on a failing proposer', async () => {
    const slice = [fakeTask('t1', 'INV-SECRET-2026'), fakeTask('t2'), fakeTask('t3'), fakeTask('t4')];
    const fake = new FakeStablehand({
      behaviour: rules,
      proposals: [
        proposal(`${BASELINE.instructions}\nThe invoice number is INV-SECRET-2026.`),
        'I think you should add more rules.',
      ],
    });
    const result = await runCampaign(settings({ slice }), fake);
    expect(result.stopReason).toBe('proposer-failing');
    expect(result.iterations.map((record) => record.decision)).toEqual(['baseline', 'invalid', 'invalid']);
    expect(result.iterations[1]?.reason).toContain('copy an expected answer (INV-SECRET-2026)');
    expect(result.iterations[2]?.reason).toContain('did not reply with a JSON object');
    expect(result.iterations[1]?.receipt.runs).toBe(1);
  });
});

describe('proposals', () => {
  const space = settings().searchSpace;

  it('accepts listed settings and refuses the rest', () => {
    const ok = parseProposal(JSON.stringify({ summary: 'bigger model', model: 'model-large', maxTokens: 2000 }), BASELINE, space, []);
    expect(ok).toMatchObject({ ok: true, config: { model: 'model-large', maxTokens: 2000, instructions: BASELINE.instructions } });
    expect(parseProposal(JSON.stringify({ model: 'model-huge' }), BASELINE, space, [])).toMatchObject({ ok: false, reason: 'model model-huge is not allowed' });
    expect(parseProposal(JSON.stringify({ maxTokens: 99_999 }), BASELINE, space, [])).toMatchObject({ ok: false });
    expect(parseProposal(JSON.stringify({ reasoning: 'high' }), BASELINE, space, [])).toMatchObject({ ok: false });
    expect(parseProposal(JSON.stringify({ summary: 'same', instructions: BASELINE.instructions }), BASELINE, space, []))
      .toMatchObject({ ok: false, reason: 'the proposal changes nothing' });
  });

  it('builds the answer key from expected values but not from words the request uses', () => {
    const tasks = [
      { ...fakeTask('a'), fields: { resolution: 'one of: refund, replacement' }, expected: { resolution: 'refund', total: 248413, rate: 0.19, code: 'DE' } },
    ];
    expect(answerKeyValues(tasks)).toEqual(['248413']);
  });

  it('shows the diff between two configurations', () => {
    expect(diffConfigs(BASELINE, { ...BASELINE, model: 'model-large' })).toContain('- model: model-small\n+ model: model-large');
    expect(diffConfigs(BASELINE, BASELINE)).toBe('');
  });
});

describe('reports', () => {
  it('draws keep and discard marks and hands the reviewer exact tool input', async () => {
    const fake = new FakeStablehand({
      behaviour: rules,
      proposals: [
        proposal(`${BASELINE.instructions}\nRULE-A: dates.`, 'add rule A'),
        proposal(`${BASELINE.instructions}\nRULE-A: dates.\nBe brief.`, 'brevity'),
      ],
    });
    const result = await runCampaign(settings({ maxIterations: 2 }), fake);
    const html = resultsPage(result);
    expect(html).toContain('<g class="mark-keep">');
    expect(html).toContain('<g class="mark-discard">');
    expect(html).toContain('<g class="mark-baseline">');
    expect(html).not.toMatch(/<script/i);

    const task = reviewerTask(result, { resultsArtifactId: 'art-1', productionAgent: 'fake-agent' });
    const inputs = task.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toMatchObject({ component: 'LineChart', props: { xKey: 'iteration', yKey: ['score', 'best'] } });
    expect(inputs[1]).toMatchObject({ component: 'TableView' });
    expect(inputs[2]).toMatchObject({
      reason: 'Promote the configuration from iteration 1 to fake-agent?',
      details: { slice: '0.250 -> 0.750 on 4 tasks', resultsArtifactId: 'art-1' },
    });
  });
});
