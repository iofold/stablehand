import { describe, expect, it } from 'vitest';
import { EARLY_LADDER, ceilingCertain, decide, familyState, frontierNextLaunch, plan, stageFits, tally, wilson } from './calibrate-ladder.ts';
import type { AttemptResult, Family, FamilyView } from './calibrate-ladder.ts';

const r = (s: string): Array<AttemptResult | 'pending'> =>
  [...s].map((c) => (c === 'P' ? 'pass' : c === 'F' ? 'fail' : c === 'E' ? 'error' : 'pending'));

const view = (family: Family, results: string, blocked = false): FamilyView => ({
  family,
  model: `${family}-model`,
  tally: tally(r(results)),
  budget_blocked: blocked,
});

describe('familyState', () => {
  it('climbs 2, 4, 8, 16 and stops at the cap', () => {
    expect(familyState(tally(r('')))).toEqual({ kind: 'next', target: 2, launch: 2 });
    expect(familyState(tally(r('F')))).toEqual({ kind: 'next', target: 2, launch: 1 });
    expect(familyState(tally(r('PF')))).toEqual({ kind: 'next', target: 4, launch: 2 });
    expect(familyState(tally(r('PFFF')))).toEqual({ kind: 'next', target: 8, launch: 4 });
    expect(familyState(tally(r('PFFFFFFF')))).toEqual({ kind: 'next', target: 16, launch: 8 });
    expect(familyState(tally(r('F'.repeat(16))))).toEqual({ kind: 'complete' });
  });

  it('stops early as too easy at 2/2, 3/4 and 4/8', () => {
    expect(familyState(tally(r('PP')))).toEqual({ kind: 'too_easy', stage: 2 });
    expect(familyState(tally(r('PFPP')))).toEqual({ kind: 'too_easy', stage: 4 });
    expect(familyState(tally(r('PFPFFPFP')))).toEqual({ kind: 'too_easy', stage: 8 });
    expect(familyState(tally(r('PFPFFFFP'))).kind).toBe('next');
  });

  it('holds while anything is pending, and counts errors as attempts', () => {
    expect(familyState(tally(r('P.')))).toEqual({ kind: 'hold' });
    expect(familyState(tally(r('EE')))).toEqual({ kind: 'next', target: 4, launch: 2 });
  });
});

describe('decide', () => {
  it('rejects as too easy when the frontier stops early', () => {
    expect(decide([view('anthropic', 'PP'), view('openai', 'F')], 'anthropic')).toBe('too_easy');
  });

  it('waits while any attempt runs', () => {
    expect(decide([view('anthropic', 'PP'), view('openai', '.')], 'anthropic')).toBeNull();
  });

  it('accepts once someone passes and the frontier cannot exceed half', () => {
    // frontier 0/8: even 8 more passes make 8/16 = 50%.
    expect(decide([view('anthropic', 'FFFFFFFF'), view('openai', 'FP')], 'anthropic')).toBe('accept');
    // 1/8 could still end at 9/16.
    expect(decide([view('anthropic', 'FFFFFFFP'), view('openai', 'FP')], 'anthropic')).toBeNull();
    expect(ceilingCertain(tally(r('FFFFFFFF')))).toBe(true);
  });

  it('is out of band when the frontier ends above the ceiling', () => {
    const f = 'PFPFFFFF' + 'PPPPPPFF'; // 8/16 = exactly the ceiling
    expect(tally(r(f)).passes).toBe(8);
    expect(decide([view('anthropic', f), view('openai', 'F'.repeat(16))], 'anthropic')).toBe('accept');
    const g = 'PFPFFFFF' + 'PPPPPPPF'; // 9/16
    expect(decide([view('anthropic', g), view('openai', 'F'.repeat(16))], 'anthropic')).toBe('out_of_band');
  });

  it('flags unsolved by everyone for review', () => {
    const none = 'F'.repeat(16);
    expect(decide([view('anthropic', none), view('openai', none), view('open', none)], 'anthropic')).toBe('unsolved_review');
  });

  it('reports over_budget only when every needed stage was refused', () => {
    expect(decide([view('anthropic', 'PF', true), view('openai', 'FF', true)], 'anthropic')).toBe('over_budget');
    expect(decide([view('anthropic', 'PF', true), view('openai', 'FF')], 'anthropic')).toBeNull();
  });

  it('holds when errors could flip the decision', () => {
    // 1 pass + 1 error: as a fail the frontier continues (null); as a pass it is too easy.
    expect(decide([view('anthropic', 'PE'), view('openai', 'F')], 'anthropic')).toBeNull();
    // At the cap with no passes, one error could have been the floor.
    const none = 'F'.repeat(16);
    expect(decide([view('anthropic', none), view('openai', 'E' + 'F'.repeat(15))], 'anthropic')).toBe('held');
    // An error that cannot matter does not hold the decision.
    expect(decide([view('anthropic', 'PP'), view('openai', 'E')], 'anthropic')).toBe('too_easy');
  });
});

describe('plan', () => {
  it('lets other families grow only to the last stage the frontier finished', () => {
    expect(plan([view('anthropic', 'F'), view('openai', 'F')], 'anthropic')).toEqual([
      { family: 'anthropic', model: 'anthropic-model', launch: 1, target: 2 },
    ]);
    expect(plan([view('anthropic', 'PF'), view('openai', 'F'), view('open', '')], 'anthropic')).toEqual([
      { family: 'anthropic', model: 'anthropic-model', launch: 2, target: 4 },
      { family: 'openai', model: 'openai-model', launch: 1, target: 2 },
      { family: 'open', model: 'open-model', launch: 2, target: 2 },
    ]);
  });

  it('launches nothing once the frontier settled the verdict', () => {
    expect(plan([view('anthropic', 'PP'), view('openai', 'F')], 'anthropic')).toEqual([]);
  });

  it('runs the others freely after the frontier finished its ladder', () => {
    const none = 'F'.repeat(16);
    expect(plan([view('anthropic', none), view('openai', 'FF')], 'anthropic')).toEqual([
      { family: 'openai', model: 'openai-model', launch: 2, target: 4 },
    ]);
  });
});

describe('early decisions (cal-v2)', () => {
  const L = EARLY_LADDER;
  const d = (families: FamilyView[]) => decide(families, 'anthropic', L);
  const p = (families: FamilyView[]) => plan(families, 'anthropic', L);

  it('accepts after 4 frontier attempts with at most half passed and a pass somewhere', () => {
    expect(d([view('anthropic', 'FFFF'), view('openai', 'P')])).toBe('accept');
    expect(d([view('anthropic', 'PFFF'), view('openai', 'F')])).toBe('accept');
    expect(d([view('anthropic', 'PFPF'), view('openai', 'F')])).toBe('accept');
    // The frontier's own pass is the floor.
    expect(d([view('anthropic', 'FPFF')])).toBe('accept');
    // Two attempts are not enough to read the rate.
    expect(d([view('anthropic', 'PF'), view('openai', 'P')])).toBeNull();
    // The cal-v1 rules needed 0/8 for the same task.
    expect(decide([view('anthropic', 'FFFF'), view('openai', 'P')], 'anthropic')).toBeNull();
  });

  it('keeps the too-easy stops', () => {
    expect(d([view('anthropic', 'PP'), view('openai', 'F')])).toBe('too_easy');
    expect(d([view('anthropic', 'PFPP'), view('openai', 'F')])).toBe('too_easy');
    expect(p([view('anthropic', 'PP'), view('openai', 'F')])).toEqual([]);
  });

  it('flags unsolved_review when nobody passed by frontier 4 and others 8', () => {
    expect(d([view('anthropic', 'FFFF'), view('openai', 'F'.repeat(8)), view('open', 'F'.repeat(8))])).toBe('unsolved_review');
    // Still looking: the open family has not reached 8.
    expect(d([view('anthropic', 'FFFF'), view('openai', 'F'.repeat(8)), view('open', 'FFFF')])).toBeNull();
    expect(p([view('anthropic', 'FFFF'), view('openai', 'F'.repeat(8)), view('open', 'FFFF')])).toEqual([
      { family: 'open', model: 'open-model', launch: 4, target: 8 },
    ]);
    // With the rule off, everyone runs to 16 first.
    expect(decide([view('anthropic', 'FFFF'), view('openai', 'F'.repeat(8)), view('open', 'F'.repeat(8))], 'anthropic')).toBeNull();
  });

  it('runs the other families only while nobody has passed', () => {
    // The frontier passed once: the others are not needed, only the frontier's next stage.
    expect(p([view('anthropic', 'PF'), view('openai', 'F'), view('open', '')])).toEqual([
      { family: 'anthropic', model: 'anthropic-model', launch: 2, target: 4 },
    ]);
    // Nobody passed: the others follow the frontier's last stage.
    expect(p([view('anthropic', 'FF'), view('openai', 'F'), view('open', '')])).toEqual([
      { family: 'anthropic', model: 'anthropic-model', launch: 2, target: 4 },
      { family: 'openai', model: 'openai-model', launch: 1, target: 2 },
      { family: 'open', model: 'open-model', launch: 2, target: 2 },
    ]);
    // The frontier stopped at 0/4: the others grow freely, but never past 8.
    expect(p([view('anthropic', 'FFFF'), view('openai', 'FF'), view('open', 'FFFF')])).toEqual([
      { family: 'openai', model: 'openai-model', launch: 2, target: 4 },
      { family: 'open', model: 'open-model', launch: 4, target: 8 },
    ]);
  });

  it('reports over_budget only for stages the decision needs', () => {
    // The open family is blocked but not needed (the frontier passed); the frontier is needed and free.
    expect(d([view('anthropic', 'PF'), view('open', '', true)])).toBeNull();
    expect(d([view('anthropic', 'PF', true), view('open', '', true)])).toBe('over_budget');
    expect(d([view('anthropic', 'FFFF'), view('openai', 'FFFF', true)])).toBe('over_budget');
  });

  it('counts errors as attempts and holds when they could flip the decision', () => {
    // 1 pass, 1 error, 2 fails: accept either way.
    expect(d([view('anthropic', 'PEFF'), view('openai', 'F')])).toBe('accept');
    // 2 passes and an error: as a pass, 3/4 would be too easy.
    expect(d([view('anthropic', 'PPEF'), view('openai', 'F')])).toBe('held');
  });

  it('holds budget for the frontier only while it needs more', () => {
    expect(frontierNextLaunch([view('anthropic', 'PF'), view('openai', 'F')], 'anthropic', L)).toBe(2);
    expect(frontierNextLaunch([view('anthropic', 'FFFF'), view('openai', 'FF')], 'anthropic', L)).toBe(0);
    expect(frontierNextLaunch([view('anthropic', 'P.')], 'anthropic', L)).toBe(2);
    expect(frontierNextLaunch([view('anthropic', 'FFFF'), view('openai', 'FF')], 'anthropic')).toBe(4);
  });
});

describe('budget and stats', () => {
  it('gates a stage on k × (estimate + reserve)', () => {
    expect(stageFits(1.5, 2, 0.5, 0.25)).toBe(true);
    expect(stageFits(1.49, 2, 0.5, 0.25)).toBe(false);
  });

  it('computes a Wilson interval', () => {
    const [lo, hi] = wilson(1, 8);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(0.53);
  });
});
