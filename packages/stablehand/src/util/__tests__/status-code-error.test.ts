import { describe, expect, it } from 'vitest';

import {
  hasStatusCode,
  isStatusCodeError,
  statusCodeError,
} from '../status-code-error.js';

describe('status code error utilities', () => {
  it('creates and recognizes errors with numeric status codes', () => {
    const error = statusCodeError(404, 'not found');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('not found');
    expect(isStatusCodeError(error)).toBe(true);
    expect(hasStatusCode(error, 404)).toBe(true);
    expect(hasStatusCode(error, 500)).toBe(false);
  });

  it.each([null, 'error', {}, { statusCode: '404' }])(
    'rejects non-status-code value %j',
    (value) => {
      expect(isStatusCodeError(value)).toBe(false);
    },
  );
});
