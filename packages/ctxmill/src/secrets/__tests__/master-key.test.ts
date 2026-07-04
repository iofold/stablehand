import { describe, expect, it, vi } from 'vitest';

import {
  DEV_FALLBACK_SECRET_MASTER_KEY,
  SecretMasterKeyError,
  resolveSecretMasterKeyPassphrase,
} from '../master-key.js';

function logger() {
  return { warn: vi.fn() };
}

describe('resolveSecretMasterKeyPassphrase', () => {
  it.each([
    ['missing', { NODE_ENV: 'production' }],
    ['empty', { NODE_ENV: 'production', SECRET_MASTER_KEY: '   ' }],
    ['fallback', { NODE_ENV: 'production', SECRET_MASTER_KEY: DEV_FALLBACK_SECRET_MASTER_KEY }],
    ['short', { NODE_ENV: 'production', SECRET_MASTER_KEY: 'short' }],
  ])('throws in production when the key is %s', (_label, env) => {
    expect(() => resolveSecretMasterKeyPassphrase(env, logger())).toThrow(SecretMasterKeyError);
    expect(() => resolveSecretMasterKeyPassphrase(env, logger())).toThrow(/SECRET_MASTER_KEY/);
    expect(() => resolveSecretMasterKeyPassphrase(env, logger())).toThrow(/openssl rand/);
  });

  it('returns a real production key without warning', () => {
    const log = logger();
    const key = '1234567890123456';

    expect(resolveSecretMasterKeyPassphrase({
      NODE_ENV: 'production',
      SECRET_MASTER_KEY: key,
    }, log)).toBe(key);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['development', { NODE_ENV: 'development' }],
    ['test', { NODE_ENV: 'test' }],
    ['unset NODE_ENV', {}],
  ])('uses the fallback with one warning in %s when unset', (_label, env) => {
    const log = logger();

    expect(resolveSecretMasterKeyPassphrase(env, log)).toBe(DEV_FALLBACK_SECRET_MASTER_KEY);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('uses the fallback with one warning outside production when explicitly configured', () => {
    const log = logger();

    expect(resolveSecretMasterKeyPassphrase({
      NODE_ENV: 'development',
      SECRET_MASTER_KEY: DEV_FALLBACK_SECRET_MASTER_KEY,
    }, log)).toBe(DEV_FALLBACK_SECRET_MASTER_KEY);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('returns a real non-production key without warning', () => {
    const log = logger();
    const key = 'local-but-not-default';

    expect(resolveSecretMasterKeyPassphrase({
      NODE_ENV: 'test',
      SECRET_MASTER_KEY: key,
    }, log)).toBe(key);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
