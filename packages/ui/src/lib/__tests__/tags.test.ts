import { describe, expect, it } from 'vitest';

import { parseTagsInput, userVisibleTags } from '../tags';

describe('parseTagsInput', () => {
  it('parses comma-separated key=value pairs', () => {
    expect(parseTagsInput('team=growth, env=prod')).toEqual({
      tags: { team: 'growth', env: 'prod' },
    });
  });

  it('returns empty tags for blank input', () => {
    expect(parseTagsInput('')).toEqual({ tags: {} });
    expect(parseTagsInput('  ,  ')).toEqual({ tags: {} });
  });

  it('rejects malformed entries instead of guessing', () => {
    expect(parseTagsInput('team')).toEqual({ error: 'Tag "team" must look like key=value' });
    expect(parseTagsInput('team=')).toEqual({ error: 'Tag "team=" must look like key=value' });
    expect(parseTagsInput('=growth')).toEqual({ error: 'Tag "=growth" must look like key=value' });
  });

  it('keeps values containing equals signs intact', () => {
    expect(parseTagsInput('query=a=b')).toEqual({ tags: { query: 'a=b' } });
  });
});

describe('userVisibleTags', () => {
  it('hides system-stamped tags', () => {
    expect(userVisibleTags({
      agent: 'agent-1',
      harness: 'langgraph',
      mode: 'interactive',
      team: 'growth',
    })).toEqual([['team', 'growth']]);
    expect(userVisibleTags(null)).toEqual([]);
  });
});
