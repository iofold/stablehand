import { describe, it, expect } from 'vitest';
import { getErrorMessage, isHttpError } from '../errors.js';

describe('getErrorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });
  it('converts non-Error to string', () => {
    expect(getErrorMessage('string error')).toBe('string error');
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(null)).toBe('null');
  });
});

describe('isHttpError', () => {
  it('returns true for matching status codes', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isHttpError(err, [400, 401, 403])).toBe(true);
  });
  it('returns false for non-matching status', () => {
    const err = Object.assign(new Error('Server Error'), { status: 500 });
    expect(isHttpError(err, [400, 401, 403])).toBe(false);
  });
  it('returns false for non-Error values', () => {
    expect(isHttpError('not an error', [400])).toBe(false);
  });
});
