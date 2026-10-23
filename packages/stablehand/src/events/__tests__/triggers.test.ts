import { describe, expect, it } from 'vitest';

import { interpolateTemplate, renderConversationKey } from '../triggers.js';

describe('interpolateTemplate', () => {
  const payload = {
    title: 'Q3 campaign',
    count: 3,
    ok: false,
    summary: { headline: 'Revenue up', metrics: { revenue: 1.2, churn: 0.04 } },
    items: [{ name: 'alpha' }, { name: 'beta' }],
    tags: ['a', 'b'],
    empty: null,
  };

  it('renders strings, numbers and booleans as text', () => {
    expect(interpolateTemplate('{{payload.title}} / {{payload.count}} / {{payload.ok}}', payload))
      .toBe('Q3 campaign / 3 / false');
  });

  it('renders nested objects and arrays as compact JSON instead of [object Object] (ctx-et0w)', () => {
    const task = interpolateTemplate('Summary: {{payload.summary}} Items: {{payload.items}} Tags: {{payload.tags}}', payload);

    expect(task).not.toContain('[object Object]');
    expect(task).toBe(
      'Summary: {"headline":"Revenue up","metrics":{"revenue":1.2,"churn":0.04}} '
      + 'Items: [{"name":"alpha"},{"name":"beta"}] Tags: ["a","b"]',
    );
  });

  it('follows dotted paths into nested fields and array items', () => {
    expect(interpolateTemplate(
      '{{payload.summary.headline}}: {{payload.summary.metrics.revenue}}, first {{payload.items.0.name}}',
      payload,
    )).toBe('Revenue up: 1.2, first alpha');
    expect(interpolateTemplate('{{payload.summary.metrics}}', payload)).toBe('{"revenue":1.2,"churn":0.04}');
  });

  it('renders the whole payload as compact JSON', () => {
    expect(interpolateTemplate('All: {{payload}}', { a: { b: [1, 2] } })).toBe('All: {"a":{"b":[1,2]}}');
  });

  it('leaves missing, null and prototype-only fields as visible placeholders', () => {
    expect(interpolateTemplate('{{payload.nope}} {{payload.empty}} {{payload.summary.nope.deeper}}', payload))
      .toBe('{{payload.nope}} {{payload.empty}} {{payload.summary.nope.deeper}}');
    expect(interpolateTemplate('{{payload.constructor}} {{payload.toString}}', payload))
      .toBe('{{payload.constructor}} {{payload.toString}}');
  });

  it('accepts whitespace inside the braces', () => {
    expect(interpolateTemplate('{{ payload.title }} {{ payload }}', { title: 'x' })).toBe('x {"title":"x"}');
  });

  it('does not re-interpolate placeholders that arrive inside payload values', () => {
    expect(interpolateTemplate('{{payload.note}}', { note: '{{payload.secret}}', secret: 's3cret' }))
      .toBe('{{payload.secret}}');
  });
});

describe('renderConversationKey', () => {
  it('renders the thread key from the event payload', () => {
    expect(renderConversationKey('{{payload.threadId}}', { threadId: '<msg-1@example.com>' })).toBe('<msg-1@example.com>');
    expect(renderConversationKey('inbox:{{payload.thread.id}}', { thread: { id: 7 } })).toBe('inbox:7');
  });

  it('gives no key when the template is unset or the event lacks a field', () => {
    expect(renderConversationKey(undefined, { threadId: 'a' })).toBeUndefined();
    expect(renderConversationKey('  ', { threadId: 'a' })).toBeUndefined();
    expect(renderConversationKey('{{payload.threadId}}', {})).toBeUndefined();
    expect(renderConversationKey('{{payload.threadId}}', { threadId: null })).toBeUndefined();
    expect(renderConversationKey('{{payload.threadId}}', { threadId: '   ' })).toBeUndefined();
    expect(renderConversationKey('a-{{payload.x}}-{{payload.y}}', { x: 1 })).toBeUndefined();
  });
});
