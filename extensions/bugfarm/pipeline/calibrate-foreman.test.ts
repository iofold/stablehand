import { describe, expect, it } from 'vitest';
import { panelMismatch, toOutcome } from './calibrate-foreman.ts';
import { defaultPanel } from './calibrate-panel.ts';
import type { CalibrationResult } from './calibrate.ts';

const frozen = { ...defaultPanel(), frozen_at: 'x', sha: 'abc', routes: [] };

const result = (decision: CalibrationResult['decision']): CalibrationResult => ({
  task: 't',
  item: 'c:fastapi@abc',
  panel: { id: 'cal-v1', sha: 'abc' },
  perFamily: {
    anthropic: { model: 'claude-sonnet-5', passes: 0, attempts: 8, errors: 0, rate: 0, ci95: [0, 0.37], state: 'open' },
    openai: { model: 'gpt-6-luna', passes: 1, attempts: 2, errors: 1, rate: 0.5, ci95: [0.09, 0.91], state: 'open' },
  },
  decision,
  cost: 5.87,
  cost_this_call: 5.87,
  cost_settled: true,
  screen: { cheap: 'pass', frontier: 'fail' },
  attempts: 10,
});

describe('foreman adapter', () => {
  it('maps decisions onto the foreman outcome', () => {
    expect(toOutcome(result('accept'))).toMatchObject({ state: 'accepted', costUsd: 5.87, difficulty: { anthropic: { passes: 0, attempts: 8 }, openai: { passes: 1, attempts: 2 } } });
    expect(toOutcome(result('too_easy'))).toMatchObject({ state: 'rejected', reason: 'too_easy' });
    expect(toOutcome(result('over_budget'))).toMatchObject({ state: 'rejected', reason: 'over_budget' });
    expect(toOutcome(result('held'))).toMatchObject({ state: 'pending', reason: 'held_errors' });
    expect(toOutcome(result('screened')).state).toBe('pending');
  });

  it('checks the foreman panel against the frozen ladder models', () => {
    const same = { entries: frozen.families.filter((f) => f.ladder).map((f) => ({ harness: 'terminus-2', model: f.ladder as string, family: f.family })) };
    expect(panelMismatch(frozen, same)).toBeNull();
    const other = { entries: [{ harness: 'terminus-2', model: 'claude-haiku-4-5', family: 'anthropic' }] };
    expect(panelMismatch(frozen, other)).toContain('anthropic: asked terminus-2/claude-haiku-4-5, frozen terminus-2/claude-sonnet-5');
  });
});
