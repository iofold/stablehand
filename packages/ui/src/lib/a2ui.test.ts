import { describe, expect, it } from 'vitest';
import {
  extractEmbeddedA2UIBlocks,
  normalizeA2UIBlock,
  normalizeA2UIComponentName,
  normalizeStoredA2UIBlocks,
  stripEmbeddedA2UIBlocks,
} from './a2ui';

describe('a2ui helpers', () => {
  it('normalizes supported component aliases to canonical names', () => {
    expect(normalizeA2UIComponentName('ctxmill.charts:MetricCard')).toBe('MetricCard');
    expect(normalizeA2UIComponentName('charts:MetricCard')).toBe('MetricCard');
    expect(normalizeA2UIComponentName('ctxmill.hitl:ApprovalCard')).toBe('ApprovalCard');
  });

  it('normalizes stored blocks and fills missing ids', () => {
    const blocks = normalizeStoredA2UIBlocks([
      { component: 'ctxmill.charts:MetricCard', props: { title: 'Users', value: 42 } },
    ], 'msg-a2ui');

    expect(blocks).toEqual([
      { id: 'msg-a2ui-0', component: 'MetricCard', props: { title: 'Users', value: 42 } },
    ]);
  });

  it('extracts and strips embedded blocks from assistant text', () => {
    const text = 'Before {"component":"ctxmill.charts:MetricCard","props":{"title":"Users","value":42}} after';

    const blocks = extractEmbeddedA2UIBlocks(text, 'embedded');
    expect(blocks).toHaveLength(1);
    expect(blocks?.[0].component).toBe('MetricCard');

    expect(stripEmbeddedA2UIBlocks(text)).toBe('Before  after'.trim());
  });

  it('ignores invalid block payloads', () => {
    expect(normalizeA2UIBlock({ component: 123 }, 'fallback')).toBeUndefined();
  });
});
