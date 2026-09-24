import { describe, expect, it } from 'vitest';
import { normalizeA2UIComponentName } from './a2ui';

describe('a2ui helpers', () => {
  it('normalizes supported component aliases to canonical names', () => {
    expect(normalizeA2UIComponentName('stablehand.charts:MetricCard')).toBe('MetricCard');
    expect(normalizeA2UIComponentName('charts:MetricCard')).toBe('MetricCard');
    expect(normalizeA2UIComponentName('stablehand.hitl:ApprovalCard')).toBe('stablehand.hitl:ApprovalCard');
  });
});
