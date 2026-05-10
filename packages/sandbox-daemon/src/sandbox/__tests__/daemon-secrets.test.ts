import { describe, expect, it } from 'vitest';

import { buildSecretsFromEnv } from '../daemon.js';

describe('sandbox daemon secret env collection', () => {
  it('collects defined environment variables as resolved secrets', () => {
    expect(buildSecretsFromEnv({
      OPENAI_API_KEY: 'sk-test',
      GOOGLE_API_KEY: 'gemini-test',
      EMPTY_BUT_DEFINED: '',
      UNDEFINED_SECRET: undefined,
    })).toEqual({
      OPENAI_API_KEY: 'sk-test',
      GOOGLE_API_KEY: 'gemini-test',
      EMPTY_BUT_DEFINED: '',
    });
  });
});
