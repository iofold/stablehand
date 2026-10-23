import { describe, expect, it } from 'vitest';
import type { RowKind } from '../shared/board.js';
import { mergePayload } from '../store/payload.js';
import { validatePayload } from '../store/validate.js';
import { SimWorld, wilson } from '../sim/world.js';

describe('simulator', () => {
  it('produces only valid, simulated rows and finishes batches with publishing', () => {
    const world = new SimWorld({ seed: 7, speed: 20 });
    const state = new Map<string, Record<string, unknown>>();
    const apply = (rows: { kind: RowKind; key: string; payload: Record<string, unknown>; mode?: string }[]) => {
      for (const row of rows) {
        const id = `${row.kind}:${row.key}`;
        const previous = state.get(id);
        const merged = row.mode === 'replace' || !previous ? row.payload : mergePayload(previous, row.payload);
        const checked = validatePayload(row.kind, merged);
        expect(checked, `${id}: ${checked.ok ? '' : checked.error}`).toMatchObject({ ok: true });
        expect(merged.simulated).toBe(true);
        state.set(id, merged);
      }
    };

    let now = 1_800_000_000_000;
    for (const chunk of world.seed(now)) apply(chunk);
    const seededBatches = [...state.keys()].filter((key) => key.startsWith('batch:'));
    expect(seededBatches).toHaveLength(4);

    for (let i = 0; i < 4000; i += 1) {
      now += 100;
      apply(world.tick(now));
    }

    const items = [...state.entries()].filter(([key]) => key.startsWith('item:')).map(([, payload]) => payload);
    const stages = new Set(items.map((item) => item.stage));
    expect(stages.has('published')).toBe(true);
    expect(stages.has('rejected')).toBe(true);
    for (const item of items.filter((entry) => entry.stage === 'rejected')) {
      expect(typeof item.reject_reason).toBe('string');
    }
    const campaign = state.get('campaign:sim');
    expect(campaign).toMatchObject({ cap_usd: 500, recovered_from_crash: 1 });
    expect(Number(campaign?.batch)).toBeGreaterThan(4);
    const rules = [...state.entries()].filter(([key]) => key.startsWith('rule:')).map(([, payload]) => payload.status);
    expect(rules).toContain('kept');
    expect(rules).toContain('trial');
    expect([...state.keys()].some((key) => key.startsWith('attempt:'))).toBe(true);
    expect([...state.keys()].some((key) => key.startsWith('cell:'))).toBe(true);
  });

  it('computes a Wilson interval that brackets the observed rate', () => {
    const [low, high] = wilson(20, 50);
    expect(low).toBeLessThan(0.4);
    expect(high).toBeGreaterThan(0.4);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});
