import { describe, expect, it } from 'vitest';
import { failingOutputFor, selectSubset } from '../../pipeline/lib/check-candidate.ts';
import type { PytestRun } from '../../pipeline/lib/pytest.ts';
import { cleanTitle } from '../foreman/foreman.js';

describe('selectSubset', () => {
  const modules = [
    'tests/test_routing.py',
    'tests/test_routing_extra.py',
    'tests/test_forms.py',
    'tests/test_other.py',
    'tests/sub/test_deep.py',
    'tests/benchmarks/test_bench.py',
  ];

  it('keeps the targets and adds modules named after a touched source file first', () => {
    const subset = selectSubset({
      modules,
      targets: ['tests/test_forms.py'],
      sourceFiles: ['fastapi/routing.py'],
      ignored: ['tests/benchmarks'],
      seed: 'abc',
      extra: 2,
    });
    expect(subset[0]).toBe('tests/test_forms.py');
    expect(subset.slice(1).sort()).toEqual(['tests/test_routing.py', 'tests/test_routing_extra.py']);
  });

  it('is stable for the same seed and never includes ignored modules', () => {
    const input = { modules, targets: ['tests/test_forms.py'], sourceFiles: ['fastapi/__init__.py'], ignored: ['tests/benchmarks'], seed: 'sha1', extra: 3 };
    expect(selectSubset(input)).toEqual(selectSubset(input));
    expect(selectSubset(input)).not.toContain('tests/benchmarks/test_bench.py');
    expect(selectSubset({ ...input, extra: 0 })).toEqual(['tests/test_forms.py']);
  });
});

describe('failingOutputFor', () => {
  it('keeps the failure blocks of the tests that matter', () => {
    const output = [
      'tests/test_x.py::test_a FAILED',
      '=================================== FAILURES ===================================',
      '___________________________________ test_a ___________________________________',
      'E   assert 422 == 200',
      '___________________________________ test_b ___________________________________',
      'E   assert 1 == 2',
      '=========================== short test summary info ============================',
      'FAILED tests/test_x.py::test_a - assert 422 == 200',
    ].join('\n');
    const run = { output, tail: '' } as PytestRun;
    const text = failingOutputFor(run, ['tests/test_x.py::test_a']);
    expect(text).toContain('assert 422 == 200');
    expect(text).not.toContain('assert 1 == 2');
  });
});

describe('cleanTitle', () => {
  it('drops a leading emoji or gitmoji code', () => {
    expect(cleanTitle('🐛 Fix `status_code` for SSE')).toBe('Fix `status_code` for SSE');
    expect(cleanTitle(':bug: Fix y')).toBe('Fix y');
    expect(cleanTitle('Fix z')).toBe('Fix z');
  });
});
