import { describe, it, expect } from 'vitest';
import { normalizeStreamTextDeltas } from '@stablehand/sandbox-daemon';

describe('normalizeStreamTextDeltas', () => {
  it('returns plain string chunks unchanged', () => {
    expect(normalizeStreamTextDeltas('Hello world')).toEqual(['Hello world']);
  });

  it('extracts structured text blocks', () => {
    expect(
      normalizeStreamTextDeltas([
        { type: 'text', text: 'Portfolio: ' },
        { type: 'text_delta', text: 'AAPL 100 shares' },
      ]),
    ).toEqual(['Portfolio: ', 'AAPL 100 shares']);
  });

  it('ignores non-text blocks while preserving text blocks', () => {
    expect(
      normalizeStreamTextDeltas([
        { type: 'tool_use', name: 'get-portfolio' },
        { type: 'text', text: 'Done' },
        { type: 'image', source: 'ignored' },
      ]),
    ).toEqual(['Done']);
  });

  it('returns empty array for empty string', () => {
    expect(normalizeStreamTextDeltas('')).toEqual([]);
  });

  it('returns empty array for empty text block', () => {
    expect(normalizeStreamTextDeltas({ type: 'text', text: '' })).toEqual([]);
  });

  it('extracts delta field from text blocks', () => {
    expect(
      normalizeStreamTextDeltas({ type: 'text_delta', delta: 'streaming chunk' }),
    ).toEqual(['streaming chunk']);
  });

  it('extracts value field from text blocks', () => {
    expect(
      normalizeStreamTextDeltas({ type: 'text', value: 'from value' }),
    ).toEqual(['from value']);
  });

  it('extracts nested text content after tool use', () => {
    expect(
      normalizeStreamTextDeltas({
        type: 'message',
        content: [
          { type: 'text', text: 'Current portfolio loaded.' },
        ],
      }),
    ).toEqual(['Current portfolio loaded.']);
  });
});
