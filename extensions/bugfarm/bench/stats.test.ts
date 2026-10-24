import { describe, expect, it } from 'vitest';
import { bootstrapPassAt1, cellStats, median, passAt1, quantile, seedOf } from './lib/stats.ts';
import { parseToml, tableAt } from './lib/toml.ts';

describe('passAt1', () => {
  it('averages the per-task share, so tasks weigh the same whatever their tries', () => {
    expect(passAt1([{ task: 'a', passes: 1, tries: 1 }, { task: 'b', passes: 0, tries: 3 }])).toBe(0.5);
    expect(passAt1([{ task: 'a', passes: 2, tries: 3 }, { task: 'b', passes: 1, tries: 3 }])).toBeCloseTo(0.5);
  });

  it('is null when nothing ran and skips tasks without tries', () => {
    expect(passAt1([])).toBeNull();
    expect(passAt1([{ task: 'a', passes: 0, tries: 0 }, { task: 'b', passes: 1, tries: 2 }])).toBe(0.5);
  });
});

describe('bootstrapPassAt1', () => {
  it('is reproducible from its seed and brackets the point estimate', () => {
    const tasks = [
      { task: 'a', passes: 3, tries: 3 },
      { task: 'b', passes: 0, tries: 3 },
      { task: 'c', passes: 1, tries: 3 },
      { task: 'd', passes: 2, tries: 3 },
    ];
    const one = bootstrapPassAt1(tasks, { seed: seedOf('x'), resamples: 4000 });
    const two = bootstrapPassAt1(tasks, { seed: seedOf('x'), resamples: 4000 });
    expect(one).toEqual(two);
    const p = passAt1(tasks) as number;
    expect(one!.low).toBeLessThanOrEqual(p);
    expect(one!.high).toBeGreaterThanOrEqual(p);
    expect(one!.low).toBeGreaterThanOrEqual(0);
    expect(one!.high).toBeLessThanOrEqual(1);
  });

  it('collapses when every task has the same share, and resamples tasks rather than tries', () => {
    expect(bootstrapPassAt1([{ task: 'a', passes: 1, tries: 2 }, { task: 'b', passes: 1, tries: 2 }], { seed: 1 })).toMatchObject({ low: 0.5, high: 0.5 });
    // Two tasks, one always solved and one never: the interval must span almost everything.
    const ci = bootstrapPassAt1([{ task: 'a', passes: 3, tries: 3 }, { task: 'b', passes: 0, tries: 3 }], { seed: 7 });
    expect(ci!.low).toBe(0);
    expect(ci!.high).toBe(1);
  });
});

describe('cellStats', () => {
  it('counts errors as unsolved tries and prices a solve from the whole cell spend', () => {
    const s = cellStats(
      [
        { task: 'a', result: 'pass', cost_usd: 0.5, seconds: 100 },
        { task: 'a', result: 'fail', cost_usd: 0.25, seconds: 300 },
        { task: 'b', result: 'error', cost_usd: 0.25, seconds: null },
        { task: 'b', result: 'pass', cost_usd: 1, seconds: 200 },
      ],
      seedOf('cell'),
      2000,
    );
    expect(s).toMatchObject({ tasks: 2, attempts: 4, solved: 2, tasks_solved: 2, errors: 1, pass_at_1: 0.5, cost_usd: 2, usd_per_solve: 1, usd_per_attempt: 0.5, median_seconds: 200 });
  });

  it('has no price per solve without a solve', () => {
    expect(cellStats([{ task: 'a', result: 'fail', cost_usd: 0.1, seconds: 1 }], 1, 100).usd_per_solve).toBeNull();
  });
});

describe('quantile and median', () => {
  it('interpolates', () => {
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([NaN])).toBeNull();
  });
});

describe('parseToml', () => {
  it('reads the task.toml shapes the pipeline writes', () => {
    const t = parseToml(`schema_version = "1.4"
artifacts = ["/app/fastapi"]

[metadata.bugfarm]
repo = "fastapi/fastapi" # trailing comment
fix_sha = "f90d0369380a539c673b1bbbbd86535b8cdee746"
fail_to_pass = [
  "tests/test_a.py::test_get[/default-200-expected_response0]",
  "tests/test_b.py::test_x[\\"first\\"]",
]
non_test_lines = 6

[agent]
timeout_sec = 1800.0

# --- bugfarm calibration ---
[metadata.bugfarm.calibration]
decision = "accept"
cost_usd = 5.874701

[metadata.bugfarm.difficulty.openai]
model = "gpt-6-luna"
passes = 1
attempts = 2
`);
    expect(t.artifacts).toEqual(['/app/fastapi']);
    const meta = tableAt(t, 'metadata.bugfarm');
    expect(meta?.repo).toBe('fastapi/fastapi');
    expect(meta?.fail_to_pass).toEqual(['tests/test_a.py::test_get[/default-200-expected_response0]', 'tests/test_b.py::test_x["first"]']);
    expect(meta?.non_test_lines).toBe(6);
    expect(tableAt(t, 'metadata.bugfarm.calibration')).toEqual({ decision: 'accept', cost_usd: 5.874701 });
    expect(tableAt(t, 'metadata.bugfarm.difficulty.openai')).toEqual({ model: 'gpt-6-luna', passes: 1, attempts: 2 });
    expect(tableAt(t, 'agent')?.timeout_sec).toBe(1800);
  });
});
