import { describe, expect, it } from 'vitest';

import { interpolateTagTemplates } from '../../events/triggers.js';
import { MAX_TAG_VALUE_LENGTH, parseTagsInput, pickValidTags } from '../turn-tags.js';

describe('parseTagsInput', () => {
  it('accepts a string map and returns undefined for absent or empty input', () => {
    expect(parseTagsInput({ campaign: 'bugfarm-1' })).toEqual({ campaign: 'bugfarm-1' });
    expect(parseTagsInput(undefined)).toBeUndefined();
    expect(parseTagsInput(null)).toBeUndefined();
    expect(parseTagsInput({})).toBeUndefined();
  });

  it('rejects reserved keys, empty keys and values outside the size limit', () => {
    expect(() => parseTagsInput({ agent: 'x' })).toThrow('tags.agent is reserved');
    expect(() => parseTagsInput({ ' ': 'x' })).toThrow('keys must be non-empty');
    expect(() => parseTagsInput({ campaign: '' })).toThrow('max 256 chars');
    expect(() => parseTagsInput({ campaign: 'x'.repeat(MAX_TAG_VALUE_LENGTH + 1) })).toThrow('max 256 chars');
    expect(() => parseTagsInput({ campaign: 3 })).toThrow('non-empty string');
    expect(() => parseTagsInput(['campaign'])).toThrow('must be an object');
  });

  it('names the field in its errors', () => {
    expect(() => parseTagsInput({ mode: 'x' }, 'trigger.tags')).toThrow('trigger.tags.mode is reserved');
  });
});

describe('pickValidTags', () => {
  it('keeps valid entries and drops everything parseTagsInput would reject', () => {
    expect(pickValidTags({
      campaign: 'bugfarm-1',
      agent: 'scout',
      harness: 'pi',
      mode: 'background',
      empty: '',
      long: 'x'.repeat(MAX_TAG_VALUE_LENGTH + 1),
      count: 3,
      '': 'blank',
    })).toEqual({ campaign: 'bugfarm-1' });
  });

  it('returns an empty map for non-objects', () => {
    expect(pickValidTags(undefined)).toEqual({});
    expect(pickValidTags('campaign')).toEqual({});
    expect(pickValidTags(['a'])).toEqual({});
  });
});

describe('interpolateTagTemplates', () => {
  it('fills placeholders and leaves off tags that cannot be resolved', () => {
    expect(interpolateTagTemplates({
      stage: 'review',
      batch: 'batch-{{payload.batch}}',
      repo: '{{payload.repo}}',
      whole: '{{payload}}',
      long: '{{payload.long}}',
    }, { batch: 7, long: 'x'.repeat(300) }, MAX_TAG_VALUE_LENGTH)).toEqual({
      stage: 'review',
      batch: 'batch-7',
    });
  });

  it('returns an empty map without templates', () => {
    expect(interpolateTagTemplates(undefined, {}, MAX_TAG_VALUE_LENGTH)).toEqual({});
  });
});
